/*    Copyright 2019 Firewalla Inc
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
const fireRouter = require('./FireRouter.js');

let instance = null;

const NetworkProfile = require('./NetworkProfile.js');

module.exports = class NetworkProfileManager {
  constructor() {
    if (!instance) {
      const c = require('./MessageBus.js');
      this.subscriber = new c("info");

      this.networkProfiles = {};
      if (f.isMain()) {
        setInterval(() => {
          this.refreshNetworkProfiles();
        }, 60 * 1000 * 5);
      }
      instance = this;
      this.refreshNetworkProfiles();
    }
    return instance;
  }

  redisfy(obj) {
    const redisObj = JSON.parse(JSON.stringify(obj));
    if (obj.dns) {
      redisObj.dns = JSON.stringify(obj.dns);
    }
    if (obj.intfs) {
      redisObj.intfs = JSON.stringify(obj.intfs);
    }
    if (obj.meta) {
      redisObj.meta = JSON.stringify(obj.meta);
    }
    return redisObj;
  }

  parse(redisObj) {
    const obj = JSON.parse(JSON.stringify(redisObj));
    if (redisObj.dns) {
      obj.dns = JSON.parse(redisObj.dns);
    }
    if (redisObj.intfs) {
      obj.intfs = JSON.parse(redisObj.intfs);
    }
    if (redisObj.meta) {
      obj.meta = JSON.parse(redisObj.meta);
    }
    return obj;
  }

  getNetworkProfile(uuid) {
    return this.networkProfiles[uuid];
  }

  async refreshNetworkProfiles() {
    const keys = await rclient.keysAsync("network:uuid:*");
    for (let key of keys) {
      const redisProfile = await rclient.hgetallAsync(key);
      const o = this.parse(redisProfile);
      const uuid = key.substring(13);
      if (this.networkProfiles[uuid]) {
        this.networkProfiles[uuid].update(o);
      } else {
        this.networkProfiles[uuid] = new NetworkProfile(o);
      }
      this.networkProfiles[uuid].setActive(false);
    }

    const monitoringInterfaces = fireRouter.getMonitoringInterfaces();

    for (let intf of monitoringInterfaces) {
      const profile = fireRouter.getInterfaceViaName(intf);
      const meta = profile.config && profile.config.meta;
      const uuid = meta && meta.uuid;
      if (!uuid) {
        log.info(`uuid is not defined on ${intf}, ignore this interface`);
        continue;
      }
      const state = profile.state;
      const config = profile.config;
      const updatedProfile = {
        uuid: uuid,
        intf: intf,
        ipv4: state && state.ip4,
        dns: state && state.dns,
        gateway: state && state.gateway,
        intfs: config && config.intf || [intf],
        active: config && config.enabled || false,
        meta: meta
      };
      if (!this.networkProfiles[uuid]) {
        this.networkProfiles[uuid] = new NetworkProfile(updatedProfile);
      } else {
        this.networkProfiles[uuid].update(updatedProfile);
      }
    }

    for (let uuid in this.networkProfiles) {
      const key = `network:uuid:${uuid}`;
      const profileJson = this.networkProfiles[uuid].toJson();
      // delete then set, ensure legacy data is removed
      await rclient.delAsync(key);
      await rclient.hmsetAsync(key, this.redisfy(profileJson));
    }
    return this.networkProfiles;
  }
}