/*    Copyright 2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient();
const Constants = require('./Constants.js');
const era = require('../event/EventRequestApi.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();

const KEY_PAIRED_PENDING = Constants.REDIS_KEY_EPT_PAIRED_PENDING;
const EVENT_TYPE = "phone_paired";

/*
 * Device name of a freshly paired app is NOT known at pairing time, it only comes with the appInfo
 * of the first init request, usually 20s ~ 1min later. So instead of firing the phone_paired event
 * right away in FireKick, pairing only leaves a pending record in redis:
 *
 *   sys:ept:pairedPending: { <eid>: {"ts":<pairing time>,"name":<account>,"dName":<device name>} }
 *
 * and the event is fired later on whichever comes first:
 * - netbot gets the first appInfo carrying deviceName          -> claimPending()
 * - PairedAppSensor finds the record expired or already named  -> flushPending()
 *
 * hdel of the pending record is the lock, only the caller that actually removes it fires the event,
 * so the event is fired exactly once no matter how many times the app inits.
 */
class PairedAppEventTool {

  // called by FireKick right after an app is linked to the group
  async addPending(eid, info = {}) {
    if (!eid) return;
    const record = Object.assign({}, info, { ts: info.ts || Date.now() });
    log.forceInfo(`Record pending paired app ${eid}`, record);
    await rclient.hsetAsync(KEY_PAIRED_PENDING, eid, JSON.stringify(record));
  }

  async removePending(eid) {
    if (!eid) return;
    await rclient.hdelAsync(KEY_PAIRED_PENDING, eid);
  }

  /*
   * Fire the pending phone_paired event of an eid, dName overrides the one in the pending record.
   * Returns true if the event is fired by this call.
   */
  async claimPending(eid, dName = null) {
    if (!eid) return false;

    const payload = await rclient.hgetAsync(KEY_PAIRED_PENDING, eid);
    if (!payload) return false;

    // whoever removes the pending record owns the event
    const removed = await rclient.hdelAsync(KEY_PAIRED_PENDING, eid);
    if (!removed) return false;

    let info = {};
    try {
      info = JSON.parse(payload) || {};
    } catch (err) {
      log.error(`Failed to parse pending paired record of ${eid}: ${payload}`, err.message);
    }
    if (dName) info.dName = dName;

    await this.emitPairedEvent(eid, info);
    return true;
  }

  /*
   * timeout : fire the event without dName if app does not init in time, in milliseconds
   * stale   : pending records older than this are dropped silently, they are most likely
   *           brought in by a restored backup instead of a real pairing, in milliseconds
   */
  async flushPending(timeout, stale) {
    const pending = await rclient.hgetallAsync(KEY_PAIRED_PENDING);
    if (!pending) return;

    const now = Date.now();
    for (const eid of Object.keys(pending)) {
      let info = null;
      try {
        info = JSON.parse(pending[eid]);
      } catch (err) {
        log.error(`Failed to parse pending paired record of ${eid}: ${pending[eid]}`, err.message);
      }

      if (!info || !info.ts) {
        log.error(`Drop invalid pending paired record of ${eid}`, pending[eid]);
        await this.removePending(eid);
        continue;
      }

      const age = now - info.ts;
      if (age > stale) {
        log.warn(`Drop stale pending paired record of ${eid}, paired ${Math.floor(age / 1000)} seconds ago`);
        await this.removePending(eid);
        continue;
      }

      // keep waiting for the init request as long as device name is still unknown
      if (!info.dName && age < timeout) continue;

      await this.claimPending(eid);
    }
  }

  async emitPairedEvent(eid, info = {}) {
    const ts = info.ts || Date.now();
    const labels = { eid, ts };
    if (info.name) labels.name = info.name;
    if (info.dName) labels.dName = info.dName;

    log.forceInfo(`Fire ${EVENT_TYPE} event of ${eid}`, labels);
    await era.addActionEvent(EVENT_TYPE, 1, labels, ts);

    // notification is sent by netbot in FireApi
    sem.sendEventToFireApi({
      type: "Event:NewEvent",
      message: "A new event is generated",
      event: {
        "event_type": "action",
        "action_type": EVENT_TYPE,
        "action_value": 1,
        "labels": labels
      },
    });
  }
}

module.exports = new PairedAppEventTool();
