/*    Copyright 2016-2022 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename)
const Constants = require('../net2/Constants.js');

const Sensor = require('./Sensor.js').Sensor

const extensionManager = require('./ExtensionManager.js')

const EncipherTool = require('../net2/EncipherTool.js')
const encipherTool = new EncipherTool()

const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('../net2/Firewalla.js');

class EncipherPlugin extends Sensor {

  apiRun() {
    extensionManager.onCmd("group:eid:delete", async (msg, data) => {
      const eid = data.eid;
      return this.deleteEidFromGroup(eid);
    })

    setInterval(() => {
      this.checkExpiration().catch(err =>
        log.error('Failed to run EncipherPlugin', err)
      )
    }, 1000 * 3600);
  }

  async checkExpiration() {
    if(!this.eptcloud) {
      return;
    }

    if(!f.isDevelopmentVersion()) {
      return;
    }

    log.info("checking key expiration...");

    const gid = await encipherTool.getGID();

    const diff = this.getExpireDiff(gid);
    log.info(`key will expire in ${Math.floor(diff / 1000 / 3600)} hours.`);

    if(diff < 1000 * 3600 * 6) {
      log.info("Rotating key...");
      await this.eptcloud.reKeyForAll(gid);
      const diff = this.getExpireDiff(gid);
      log.info(`Key rotated, will expire in ${Math.floor(diff / 1000 / 3600)} hours`);
    }
  }

  getExpireDiff(gid) {
    const rkeyInfo = this.eptcloud.getMaskedRKey(gid);
    if(!rkeyInfo.ts || !rkeyInfo.ttl) {
      return;
    }

    const {ts, ttl} = rkeyInfo;

    const now = new Date() / 1;
    const expireDate = ts + ttl * 1000;

    return expireDate - now;
  }

  async deleteEidFromGroup(eid) {
    if(!this.eptcloud) {
      return;
    }

    const gid = await encipherTool.getGID();
    await this.eptcloud.deleteEidFromGroup(gid, eid);
    await this.deleteEidEntryFromLocalRedis(eid);
    await rclient.hdelAsync("sys:ept:memberNames", eid);
    await rclient.hdelAsync("sys:ept:member:lastvisit", eid);
    await rclient.saddAsync(Constants.REDIS_KEY_EID_REVOKE_SET, eid);

    try {
      const historyStr = await rclient.hgetAsync("sys:ept:members:history", eid);
      if (historyStr) {
        const historyObj = JSON.parse(historyStr)
        const historyMsg = historyObj["msg"]
        const date = Math.floor(new Date() / 1000)
        historyObj["msg"] = `${historyMsg}unpaired at ${date};`;
        await rclient.hsetAsync("sys:ept:members:history", eid, JSON.stringify(historyObj));
      }
    } catch (err) {
      log.info("error when record unpaired device history info", err)
    }
    
    return;
  }

  async deleteEidEntryFromLocalRedis(eid) {
    const members = await rclient.smembersAsync("sys:ept:members");
    for(const member of members) {
      try {
        const m = JSON.parse(member);
        if(m.eid === eid) {
          await rclient.sremAsync("sys:ept:members", member);
          return;
        }
      } catch(err) {
        log.error("Failed to parse member info, err:", err);
        continue;
      }
    }
  }
}

module.exports = EncipherPlugin;
