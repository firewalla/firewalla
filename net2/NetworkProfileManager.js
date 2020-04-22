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
const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const Message = require('./Message.js');
const NetworkProfile = require('./NetworkProfile.js');

const _ = require('lodash');

class NetworkProfileManager {
  constructor() {
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    this.iptablesReady = false;
    this.networkProfiles = {};

    this.scheduleRefresh();

    if (f.isMain()) {
      sem.once('IPTABLES_READY', async () => {
        this.iptablesReady = true;
        log.info("Iptables is ready, apply network profile policies ...");
        this.scheduleRefresh();
      });

      sem.on("DeviceUpdate", (event) => {
        // notify NetworkProfile to discover more gateway's IPv6 addresses
        if (!this.iptablesReady)
          return;
        const host = event.host;
        const mac = host.mac;
        if (!mac)
          return;
        if (_.isString(host.ipv4)) {
          const intfInfo = sysManager.getInterfaceViaIP4(host.ipv4);
          if (host.ipv4 !== intfInfo.gateway)
            return;
          const uuid = intfInfo && intfInfo.uuid
          if (!uuid)
            return;
          const networkProfile = this.getNetworkProfile(uuid);
          if (!networkProfile)
            return;
          setTimeout(() => {
            networkProfile.rediscoverGateway6(mac);
          }, 3000);
        }
      });
    }

    sclient.on("message", async (channel, message) => {
      switch (channel) {
        case Message.MSG_SYS_NETWORK_INFO_RELOADED: {
          log.info("sys:network:info is reloaded, refreshing network profiles and policies ...");
          this.scheduleRefresh();
        }
      }
    });
    
    sclient.subscribe(Message.MSG_SYS_NETWORK_INFO_RELOADED);
    return this;
  }

  scheduleRefresh() {
    if (this.refreshTask)
      clearTimeout(this.refreshTask);
    this.refreshTask = setTimeout(async () => {
      await this.refreshNetworkProfiles();
      if (f.isMain()) {
        if (this.iptablesReady) {
          for (let uuid in this.networkProfiles) {
            const networkProfile = this.networkProfiles[uuid];
            networkProfile.scheduleApplyPolicy();
          }
        }
      }
    }, 3000);
  }

  redisfy(obj) {
    const redisObj = JSON.parse(JSON.stringify(obj));
    const convertKeys = ["dns", "ipv6", "ipv6Subnets", "monitoring"];
    for (const key of convertKeys) {
      if (obj[key])
        redisObj[key] = JSON.stringify(obj[key]);
    }
    return redisObj;
  }

  parse(redisObj) {
    const obj = JSON.parse(JSON.stringify(redisObj));
    const convertKeys = ["dns", "ipv6", "ipv6Subnets", "monitoring"];
    for (const key of convertKeys) {
      if (redisObj[key])
        try {
          obj[key] = JSON.parse(redisObj[key]);
        } catch (err) {}
    }
    const numberKeys = ["rtid"];
    for (const key of numberKeys) {
      if (redisObj[key])
        try {
          obj[key] = Number(redisObj[key]);
        } catch (err) {}
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

  async scheduleUpdateEnv(networkProfile, updatedProfileObject) {
    if (this.iptablesReady) {
      // use old network profile config to destroy old environment
      log.info(`Destroying environment for network ${networkProfile.o.uuid} ${networkProfile.o.intf} ...`);
      await networkProfile.destroyEnv();
      networkProfile.update(updatedProfileObject);
      // use new network profile config to create new environment
      log.info(`Creating environment for network ${networkProfile.o.uuid} ${networkProfile.o.intf} ...`);
      await networkProfile.createEnv();
    } else {
      sem.once('IPTABLES_READY', async () => {
        log.info(`Destroying environment for network ${networkProfile.o.uuid} ${networkProfile.o.intf} ...`);
        await networkProfile.destroyEnv();
        networkProfile.update(updatedProfileObject);
        log.info(`Creating environment for network ${networkProfile.o.uuid} ${networkProfile.o.intf} ...`);
        await networkProfile.createEnv();
      });
    }
  }

  _isNetworkProfileChanged(then, now) {
    const thenCopy = JSON.parse(JSON.stringify(then));
    const nowCopy = JSON.parse(JSON.stringify(now));
    for (let key in thenCopy) {
      if (_.isArray(thenCopy[key]))
      thenCopy[key] = thenCopy[key].sort();
    }
    for (let key in nowCopy) {
      if (_.isArray(nowCopy[key]))
      nowCopy[key] = nowCopy[key].sort();
    }
    // in case there is any key to exclude in future
    const excludedKeys = [];
    for (const excludedKey of excludedKeys) {
      if (thenCopy[excludedKey])
        delete thenCopy[excludedKey];
      if (nowCopy[excludedKey])
        delete nowCopy[excludedKey];
    }
    return !_.isEqual(thenCopy, nowCopy);
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
        const changed = this._isNetworkProfileChanged(networkProfile.o, o);
        if (changed) {
          // network profile changed, need to reapply createEnv
          if (f.isMain()) {
            log.info(`Network profile of ${uuid} ${networkProfile.o.intf} is changed, updating environment ...`, o);
            await this.scheduleUpdateEnv(networkProfile, o);
          }
        }
        networkProfile.update(o);
      } else {
        this.networkProfiles[uuid] = new NetworkProfile(o);
        if (f.isMain()) {
          await this.scheduleUpdateEnv(this.networkProfiles[uuid], o);
        }
      }
      this.networkProfiles[uuid].active = false;
    }

    const monitoringInterfaces = sysManager.getMonitoringInterfaces() || [];
    const logicInterfaces = sysManager.getLogicInterfaces() || [];
    for (let intf of logicInterfaces) {
      const uuid = intf.uuid;
      if (!uuid) {
        log.info(`uuid is not defined, ignore this interface`, intf);
        continue;
      }
      const monitoring = monitoringInterfaces.some(i => i.name === intf.name);
      const updatedProfile = {
        uuid: uuid,
        intf: intf.name,
        ipv4Subnet: intf.subnet,
        ipv4: intf.ip_address,
        ipv6: intf.ip6_addresses || [],
        ipv6Subnets: intf.ip6_subnets || [],
        dns: intf.dns || [],
        gateway: intf.gateway_ip || "",
        gateway6: intf.gateway6 || "",
        monitoring: monitoring,
        type: intf.type || "",
        rtid: intf.rtid || 0
      };
      if (!this.networkProfiles[uuid]) {
        this.networkProfiles[uuid] = new NetworkProfile(updatedProfile);
        if (f.isMain()) {
          await this.scheduleUpdateEnv(this.networkProfiles[uuid], updatedProfile);
        }
      } else {
        const networkProfile = this.networkProfiles[uuid];
        const changed = this._isNetworkProfileChanged(networkProfile.o, updatedProfile);
        if (changed) {
          // network profile changed, need to reapply createEnv
          if (f.isMain()) {
            log.info(`Network profile of ${uuid} ${networkProfile.o.intf} is changed, updating environment ...`, updatedProfile);
            await this.scheduleUpdateEnv(networkProfile, updatedProfile);
          }
        }
        networkProfile.update(updatedProfile);
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