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
const sysManager = require('./SysManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();

const NetworkProfile = require('./NetworkProfile.js');

class NetworkProfileManager {
  constructor() {
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    this.iptablesReady = false;
    this.networkProfiles = {};

    if (f.isMain()) {
      sem.once('IPTABLES_READY', async () => {
        this.iptablesReady = true;
        log.info("Iptables is ready, apply network profile policies ...");
        await this.refreshNetworkProfiles();
        for (let uuid in this.networkProfiles) {
          const networkProfile = this.networkProfiles[uuid];
          await networkProfile.applyPolicy();
        }
      });
    }
    this.refreshNetworkProfiles();
    return this;
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

  async toJson() {
    const json = {}
    for (let uuid in this.networkProfiles) {
      await this.networkProfiles[uuid].loadPolicy();
      json[uuid] = this.networkProfiles[uuid].toJson();
    }
    return json;
  }

  getNetworkProfile(uuid) {
    return this.networkProfiles[uuid];
  }

  async scheduleCreateEnv(networkProfile) {
    if (this.iptablesReady) {
      log.info(`Creating environment for network ${networkProfile.o.uuid} ${networkProfile.o.intf} ...`);
      await networkProfile.createEnv();
    } else {
      sem.once('IPTABLES_READY', async () => {
        log.info(`Creating environment for network ${networkProfile.o.uuid} ${networkProfile.o.intf} ...`);
        await networkProfile.createEnv();
      });
    }
  }

  async refreshNetworkProfiles() {
    const keys = await rclient.keysAsync("network:uuid:*");
    for (let key of keys) {
      const redisProfile = await rclient.hgetallAsync(key);
      const o = this.parse(redisProfile);
      const uuid = key.substring(13);
      if (!uuid) {
        log.info(`uuid is not defined, ignore this interface`, o);
        continue;
      }
      o.uuid = uuid;
      if (this.networkProfiles[uuid]) {
        const networkProfile = this.networkProfiles[uuid];
        const previousIpv4 = networkProfile.o.ipv4;
        networkProfile.update(o);
        if (o.ipv4 && previousIpv4 !== o.ipv4) {
          // network prefix changed, need to reapply createEnv
          if (f.isMain()) {
            log.info(`Network prefix of ${uuid} ${networkProfile.o.intf} changed from ${previousIpv4} to ${o.ipv4}, updating environment ...`);
            await this.scheduleCreateEnv(networkProfile);
          }
        }
      } else {
        this.networkProfiles[uuid] = new NetworkProfile(o);
        if (f.isMain()) {
          await this.scheduleCreateEnv(this.networkProfiles[uuid]);
        }
      }
      this.networkProfiles[uuid].active = false;
    }

    const monitoringInterfaces = sysManager.getMonitoringInterfaces();
    for (let intf of monitoringInterfaces) {
      const uuid = intf.uuid;
      if (!uuid) {
        log.info(`uuid is not defined on ${intf}, ignore this interface`);
        continue;
      }
      const updatedProfile = {
        uuid: uuid,
        intf: intf.name,
        ipv4: intf.subnet,
        dns: intf.dns,
        gateway: intf.gateway
      };
      if (!this.networkProfiles[uuid]) {
        this.networkProfiles[uuid] = new NetworkProfile(updatedProfile);
        if (f.isMain()) {
          await this.scheduleCreateEnv(this.networkProfiles[uuid]);
        }
      } else {
        const networkProfile = this.networkProfiles[uuid];
        const previousIpv4 = networkProfile.o.ipv4;
        networkProfile.update(updatedProfile);
        if (updatedProfile.ipv4 && previousIpv4 !== updatedProfile.ipv4) {
          // network prefix changed, need to reapply createEnv
          if (f.isMain()) {
            log.info(`Network prefix of ${uuid} ${networkProfile.o.intf} changed from ${previousIpv4} to ${updatedProfile.ipv4}, updating environment ...`);
            await this.scheduleCreateEnv(networkProfile);
          }
        }
      }
      this.networkProfiles[uuid].active = true;
    }

    const removedNetworkProfiles = {};
    Object.keys(this.networkProfiles).filter(uuid => this.networkProfiles[uuid].active === false).map((uuid) => {
      removedNetworkProfiles[uuid] = this.networkProfiles[uuid];
    });
    for (let uuid in removedNetworkProfiles) {
      if (f.isMain()) {
        await rclient.delAsync(`network:uuid:${uuid}`);
        if (this.iptablesReady) {
          log.info(`Destroying environment for network ${uuid} ${removedNetworkProfiles[uuid].o.intf} ...`);
          await removedNetworkProfiles[uuid].destroyEnv();
        } else {
          sem.once('IPTABLES_READY', async () => {
            log.info(`Destroying environment for network ${uuid} ${removedNetworkProfiles[uuid].o.intf} ...`);
            await removedNetworkProfiles[uuid].destroyEnv();
          });
        }
      }
      delete this.networkProfiles[uuid];
    }

    for (let uuid in this.networkProfiles) {
      const key = `network:uuid:${uuid}`;
      const profileJson = this.networkProfiles[uuid].o;
      if (f.isMain()) {
        await rclient.hmsetAsync(key, this.redisfy(profileJson));
      }
    }
    return this.networkProfiles;
  }
}

const instance = new NetworkProfileManager();
module.exports = instance;