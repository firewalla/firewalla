/*    Copyright 2019-2023 Firewalla Inc.
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
const f = require('./Firewalla.js');
const sysManager = require('./SysManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const VirtWanGroup = require('./VirtWanGroup.js');
const _ = require('lodash');
const Message = require('./Message.js');

const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_REFRESH_WAN_GROUPS = "LOCK_REFRESH_VWGS";
const scheduler = require('../util/scheduler.js');

class VirtWanGroupManager {
  constructor() {
    this.virtWanGroups = {};

    this.refreshJob = new scheduler.UpdateJob(this.refreshVirtWanGroups.bind(this), 5000);
    this.refreshJob.exec().catch((err) => {
      log.error("Failed to refresh virtual wan groups", err.message);
    });
    /*
    if (f.isMain()) {
      sem.once('IPTABLES_READY', async () => {
        log.info("Iptables is ready, apply virtual wan groups ...");
        this.refreshJob.exec().catch((err) => {
          log.error("Failed to refresh virtual wan groups", err.message);
        });
      });
    }
    */

    sem.on(Message.MSG_VIRT_WAN_GROUP_UPDATED, async () => {
      this.refreshJob.exec().catch((err) => {
        log.error("Failed to refresh virtual wan groups", err.message);
      });
    });
  }

  async toJson() {
    const result = [];
    for (const vwg of Object.values(this.virtWanGroups)) {
      const json = await vwg.toJson();
      result.push(json);
    }
    return result;
  }

  parse(o) {
    const result = {};
    result.uuid = o.uuid;
    result.name = o.name;
    result.type = o.type;
    if (_.isString(o.wans))
      result.wans = JSON.parse(o.wans);
    else
      result.wans = o.wans;
    if (_.isString(o.failback))
      result.failback = JSON.parse(o.failback);
    else
      result.failback = o.failback;
    if (_.isString(o.strictVPN))
      result.strictVPN = JSON.parse(o.strictVPN);
    else
      result.strictVPN = o.strictVPN;
    return result;
  }

  redisfy(o) {
    const result = {};
    result.uuid = o.uuid;
    result.name = o.name;
    result.type = o.type;
    result.failback = o.failback;
    result.strictVPN = o.strictVPN;
    if (_.isArray(o.wans))
      result.wans = JSON.stringify(o.wans);
    else
      result.wans = o.wans;
    return result;
  }

  async createOrUpdateVirtWanGroup(o) {
    if (!o.uuid) {
      o.uuid = require('uuid').v4();
    }
    await rclient.hmsetAsync(VirtWanGroup.getRedisKeyName(o.uuid), this.redisfy(o));
    if (!o.hasOwnProperty("failback"))
      await rclient.hdelAsync(VirtWanGroup.getRedisKeyName(o.uuid), "failback");
    if (!o.hasOwnProperty("strictVPN"))
      await rclient.hdelAsync(VirtWanGroup.getRedisKeyName(o.uuid), "strictVPN");
    const event = {
      type: Message.MSG_VIRT_WAN_GROUP_UPDATED
    };
    sem.sendEventToAll(event);
  }

  async removeVirtWanGroup(uuid) {
    await rclient.delAsync(VirtWanGroup.getRedisKeyName(uuid));
    const event = {
      type: Message.MSG_VIRT_WAN_GROUP_UPDATED
    };
    sem.sendEventToAll(event);
  }

  async refreshVirtWanGroups() {
    await lock.acquire(LOCK_REFRESH_WAN_GROUPS, async () => {
      const markMap = {};
      const keys = await rclient.keysAsync("virt_wan_group:*");
      for (const key of keys) {
        const data = await rclient.hgetallAsync(key);
        if (!data)
          continue;
        const o = this.parse(data);
        const uuid = key.substring(15);
        if (!this.virtWanGroups[uuid]) {
          const vwg = new VirtWanGroup(o);
          this.virtWanGroups[uuid] = vwg;
          if (f.isMain()) {
            (async () => {
              await sysManager.waitTillIptablesReady()
              log.info(`Creating environment for virtual wan group ${uuid} ...`);
              await vwg.createEnv();
              await vwg.refreshRT();
            })()
          }
        } else {
          const vwg = this.virtWanGroups[uuid];
          const updated = vwg.update(o);
          if (updated && f.isMain()) {
            (async () => {
              await sysManager.waitTillIptablesReady()
              log.info(`Updating routing for virtual wan group ${uuid} ...`, o);
              await vwg.refreshRT();
            })()
          }
        }
        markMap[uuid] = true;
      }
      const removedVwgs = Object.keys(this.virtWanGroups).filter(uuid => markMap[uuid] !== true).map(uuid => this.virtWanGroups[uuid]);
      for (const vwg of removedVwgs) {
        if (f.isMain()) {
          await rclient.unlinkAsync(VirtWanGroup.getRedisKeyName(vwg.uuid));
          (async () => {
            await sysManager.waitTillIptablesReady()
            log.info(`Destroying environment for virtual wan group ${vwg.uuid} ...`);
            await vwg.destroyEnv();
          })()
        }
        delete this.virtWanGroups[vwg.uuid];
      }
    }).catch((err) => {
      log.error("Failed to refresh virtual wan groups", err);
    });
  }
}

module.exports = new VirtWanGroupManager();
