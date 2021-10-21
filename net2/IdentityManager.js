/*    Copyright 2021 Firewalla Inc.
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

const sem = require('../sensor/SensorEventManager.js').getInstance();
const f = require('./Firewalla.js');
const { Address4, Address6 } = require('ip-address');
const Message = require('./Message.js');
const sysManager = require('./SysManager')

const Promise = require('bluebird');
const _ = require('lodash');
const fs = require('fs');
Promise.promisifyAll(fs);


class IdentityManager {
  constructor() {
    this.allIdentities = {};
    this.nsClassMap = {};
    this.ipUidMap = {};
    this.ipEndpointMap = {};

    this.refreshIdentityTasks = {};
    this.refreshIPMappingsTasks = {};
    this._refreshIdentityInProgress = {};
    this._refreshIPMappingsInProgress = {};
    this.loadIdentityClasses();

    this.scheduleRefreshIdentities();
    if (f.isMain()) {
      sem.once('IPTABLES_READY', async () => {
        log.info("Iptables is ready, refreshing all identities ...");
        this.scheduleRefreshIdentities();

        sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async (event) => {
          for (const ns of Object.keys(this.nsClassMap)) {
            const c = this.nsClassMap[ns];
            if (this.allIdentities[ns]) {
              for (const uid of Object.keys(this.allIdentities[ns])) {
                await c.ensureCreateEnforcementEnv(uid).catch((err) => {
                  log.error(`Failed to create enforcement env for identity ${ns} ${uid}`, err.message);
                });
              }
            }
          }
        });
      });
    }

    for (const ns of Object.keys(this.nsClassMap)) {
      const c = this.nsClassMap[ns];
      let events = c.getRefreshIdentitiesHookEvents() || [];
      for (const e of events) {
        sem.on(e, async (event) => {
          log.info(`Schedule refreshing identity ${ns} on receiving event`, event);
          this.scheduleRefreshIdentities([ns]);
        });
      }
      events = c.getRefreshIPMappingsHookEvents() || [];
      for (const e of events) {
        sem.on(e, async (event) => {
          log.info(`Schedule refreshing IP mappings of identity ${ns} on receiving event`, event);
          this.scheduleRefreshIPMappings([ns]);
        });
      }
    }
    return this;
  }

  loadIdentityClasses() {
    const files = fs.readdirSync(`${__dirname}/identity`);
    for (const file of files) {
      const identity = require(`./identity/${file}`);
      if (!identity.isEnabled())
        continue;
      const ns = identity.getNamespace();
      if (!this.nsClassMap.hasOwnProperty(ns))
        this.nsClassMap[ns] = identity;
      if (!this.allIdentities.hasOwnProperty(ns))
        this.allIdentities[ns] = {};
      if (!this.ipUidMap.hasOwnProperty(ns))
        this.ipUidMap[ns] = {};
      if (!this.ipEndpointMap.hasOwnProperty(ns))
        this.ipEndpointMap[ns] = {};
    }
  }

  async cleanUpIdentityData(identity) {
    if (!identity)
      return;
    const PolicyManager2 = require('../alarm/PolicyManager2.js');
    const AlarmManager2 = require('../alarm/AlarmManager2.js');
    const ExceptionManager = require('../alarm/ExceptionManager.js');
    const pm2 = new PolicyManager2();
    const am2 = new AlarmManager2();
    const em = new ExceptionManager();
    const TypeFlowTool = require('../flow/TypeFlowTool.js');
    const categoryFlowTool = new TypeFlowTool('category');
    const FlowAggrTool = require('../net2/FlowAggrTool');
    const flowAggrTool = new FlowAggrTool();
    const FlowManager = require('../net2/FlowManager.js');
    const flowManager = new FlowManager('info');
    const guid = this.getGUID(identity);
    await pm2.deleteMacRelatedPolicies(guid);
    await em.deleteMacRelatedExceptions(guid);
    await am2.deleteMacRelatedAlarms(guid);
    await categoryFlowTool.delAllTypes(guid);
    await flowAggrTool.removeAggrFlowsAll(guid);
    await flowManager.removeFlowsAll(guid);
  }

  scheduleRefreshIdentities(nss = null) {
    nss = _.isArray(nss) ? nss : Object.keys(this.nsClassMap);

    for (const ns of nss) {
      if (this.refreshIdentityTasks[ns])
        clearTimeout(this.refreshIdentityTasks[ns]);
      this.refreshIdentityTasks[ns] = setTimeout(async () => {
        if (this._refreshIdentityInProgress[ns]) {
          log.info(`Refresh identity ${ns} in progress, will schedule later ...`);
          this.scheduleRefreshIdentities([ns]);
        } else {
          try {
            this._refreshIdentityInProgress[ns] = true;
            await this.refreshIdentity(ns);
            this.scheduleRefreshIPMappings([ns]);
            if (f.isMain() && sysManager.isIptablesReady()) {
              for (const uid of Object.keys(this.allIdentities[ns])) {
                const identity = this.allIdentities[ns][uid];
                await this.nsClassMap[ns].ensureCreateEnforcementEnv(uid);
                identity.scheduleApplyPolicy();
              }
            }
          } catch (err) {
            log.error(`Failed to refresh Identity of ${ns}`, err);
          } finally {
            this._refreshIdentityInProgress[ns] = false;
          }
        }
      }, 3000);
    }
  }

  async refreshIdentity(ns) {
    const c = ns && this.nsClassMap[ns];
    if (!c)
      return;
    const previousIdentities = this.allIdentities[ns] || {};
    const currentIdentities = await c.getIdentities();
    const removedIdentities = Object.keys(previousIdentities).filter(uid => !Object.keys(currentIdentities).includes(uid)).map(uid => previousIdentities[uid]);
    const newIdentities = Object.keys(currentIdentities).filter(uid => !Object.keys(previousIdentities).includes(uid)).map(uid => currentIdentities[uid]);
    if (f.isMain()) {
      for (const identity of removedIdentities) {
        if (sysManager.isIptablesReady()) {
          log.info(`Destroying environment for identity ${ns} ${identity.getUniqueId()} ...`);
          await this.cleanUpIdentityData(identity);
          await identity.destroyEnv();
        } else {
          sem.once('IPTABLES_READY', async () => {
            log.info(`Destroying environment for identity ${ns} ${identity.getUniqueId()} ...`);
            await this.cleanUpIdentityData(identity);
            await identity.destroyEnv();
          });
        }
      }
      for (const identity of newIdentities) {
        if (sysManager.isIptablesReady()) {
          log.info(`Creating environment for identity ${ns} ${identity.getUniqueId()} ...`);
          await identity.createEnv();
        } else {
          sem.once('IPTABLES_READY', async () => {
            log.info(`Creating environment for identity ${ns} ${identity.getUniqueId()} ...`);
            await identity.createEnv();
          });
        }
      }
    }
    this.allIdentities[ns] = Object.assign({}, currentIdentities); // use a new hash object in case currentIdentities is changed by Identity instance
  }

  scheduleRefreshIPMappings(nss) {
    nss = _.isArray(nss) ? nss : Object.keys(this.nsClassMap);

    for (const ns of nss) {
      if (this.refreshIPMappingsTasks[ns])
        clearTimeout(this.refreshIPMappingsTasks[ns]);
      this.refreshIPMappingsTasks[ns] = setTimeout(async () => {
        if (this._refreshIPMappingsInProgress[ns]) {
          log.info(`Refresh IP mappings ${ns} in progress, will schedule later ...`);
          this.scheduleRefreshIPMappings([ns]);
        } else {
          try {
            this._refreshIPMappingsInProgress[ns] = true;
            await this.refreshIPMappingsOfIdentity(ns);
            if (f.isMain() && sysManager.isIptablesReady()) {
              const identities = this.allIdentities[ns] || {};
              for (const uid of Object.keys(identities)) {
                const ips = Object.keys(this.ipUidMap[ns]).filter(ip => this.ipUidMap[ns][ip] === uid);
                identities[uid] && await identities[uid].updateIPs(ips);
              }
            }
          } catch (err) {
            log.error(`Failed to refresh IP mappings of ${ns}`, err);
          } finally {
            this._refreshIPMappingsInProgress[ns] = false;
          }
        }
      }, 3000);
    }
  }

  async refreshIPMappingsOfIdentity(ns) {
    const c = ns && this.nsClassMap[ns];
    if (!c)
      return;
    const ipUidMap = await c.getIPUniqueIdMappings();
    this.ipUidMap[ns] = ipUidMap;
    const ipEndpointMap = await c.getIPEndpointMappings();
    this.ipEndpointMap[ns] = ipEndpointMap;
  }

  getIdentity(ns, uid) {
    return this.allIdentities[ns] && this.allIdentities[ns][uid];
  }

  isGUID(str) {
    const [ns, uid] = str && str.split(':', 2);
    if (this.allIdentities[ns])
      return true;
    return false;
  }

  getIdentityByGUID(guid) {
    const [ns, uid] = guid && guid.split(':', 2);
    return this.getIdentity(ns, uid);
  }

  getIdentityByIP(ip) {
    // Quick path. In most cases, key in this.ipUidMap is bare IP address and can be directly compared with argument ip
    for (const ns of Object.keys(this.ipUidMap)) {
      const ipUidMap = this.ipUidMap[ns];
      const uid = ipUidMap && (ipUidMap[ip] || ipUidMap[`${ip}/32`] || ipUidMap[`${ip}/128`]);
      if (uid && this.allIdentities[ns] && this.allIdentities[ns][uid])
        return this.allIdentities[ns][uid];
    }
    // Slow path. Match argument ip with cidr keys of this.ipUidMap
    for (const ns of Object.keys(this.ipUidMap)) {
      const ipUidMap = this.ipUidMap[ns];
      const cidr = Object.keys(ipUidMap).find(subnet => {
        const ip4 = new Address4(ip);
        if (ip4.isValid()) {
          const subnet4 = new Address4(subnet);
          return subnet4.isValid() && ip4.isInSubnet(subnet4);
        } else {
          const ip6 = new Address6(ip);
          if (ip6.isValid()) {
            const subnet6 = new Address6(subnet);
            return subnet6.isValid() && ip6.isInSubnet(subnet6);
          } else
            return false;
        }
      });
      if (cidr) {
        const uid = ipUidMap[cidr];
        if (this.allIdentities[ns] && this.allIdentities[ns][uid])
          return this.allIdentities[ns][uid];
      }
    }
    return null;
  }

  getEndpointByIP(ip) {
    // Quick path. In most cases, key in this.ipEndpointMap is bare IP address and can be directly compared with argument ip
    for (const ns of Object.keys(this.ipEndpointMap)) {
      const ipEndpointMap = this.ipEndpointMap[ns];
      const endpoint = ipEndpointMap && (ipEndpointMap[ip] || ipEndpointMap[`${ip}/32`] || ipEndpointMap[`${ip}/128`]);
      if (endpoint)
        return endpoint;
    }
    // Slow path. Match argument ip with cidr keys of this.ipEndpointMap
    for (const ns of Object.keys(this.ipEndpointMap)) {
      const ipEndpointMap = this.ipEndpointMap[ns];
      const cidr = Object.keys(ipEndpointMap).find(subnet => {
        const ip4 = new Address4(ip);
        if (ip4.isValid()) {
          const subnet4 = new Address4(subnet);
          return subnet4.isValid() && ip4.isInSubnet(subnet4);
        } else {
          const ip6 = new Address6(ip);
          if (ip6.isValid()) {
            const subnet6 = new Address6(subnet);
            return subnet6.isValid() && ip6.isInSubnet(subnet6);
          } else
            return false;
        }
      });
      if (cidr)
        return ipEndpointMap[cidr];
    }
    return null;
  }

  getIdentities(ns) {
    return this.allIdentities[ns];
  }

  getAllIdentities() {
    return this.allIdentities;
  }

  getGUID(identity) {
    return `${identity.constructor.getNamespace()}:${identity.getUniqueId()}`;
  }

  getNSAndUID(guid) {
    if (!this.isGUID(guid))
      return null;
    const [ns, uid] = guid && guid.split(':', 2);
    return {ns, uid};
  }

  getIdentityClassByGUID(guid) {
    if (!this.isGUID(guid))
      return null;
    const [ns, uid] = guid && guid.split(':', 2);
    return this.nsClassMap[ns];
  }

  getAllIdentitiesGUID() {
    const guids = [];
    for (const ns of Object.keys(this.allIdentities)) {
      const identities = this.allIdentities[ns];
      for (const uid of Object.keys(identities)) {
        const identity = identities[uid];
        identity && guids.push(this.getGUID(identity));
      }
    }
    return guids;
  }

  async generateInitData(json, nss) {
    nss = _.isArray(nss) ? nss : Object.keys(this.nsClassMap);
    const FlowManager = require('./FlowManager.js');
    const flowManager = new FlowManager();
    for (const ns of nss) {
      const c = this.nsClassMap[ns];
      const key = c.getKeyOfInitData();
      const data = await c.getInitData();
      if (_.isArray(data)) {
        for (const e of data) {
          if (e.uid) {
            const guid = `${c.getNamespace()}:${e.uid}`;
            e.flowsummary = await flowManager.getTargetStats(guid);
          }
        }
      }
      json[key] = data;
    }
  }

  getIdentitiesByNicName(nic) {
    const result = {};
    for (const ns of Object.keys(this.allIdentities)) {
      const identities = this.allIdentities[ns];
      const matchedIdentities = {};
      for (const uid of Object.keys(identities)) {
        if (identities[uid] && identities[uid].getNicName() === nic)
          matchedIdentities[uid] = identities[uid];
      }
      result[ns] = matchedIdentities;
    }
    return result;
  }

  isIdentity(obj) {
    for (const ns of Object.keys(this.nsClassMap)) {
      if (obj.constructor.name === this.nsClassMap[ns].name)
        return true;
    }
    return false;
  }

  // returns an array of IP or CIDRs
  getIPsByGUID(guid) {
    const { ns, uid } = this.getNSAndUID(guid)
    return Object.keys(this.ipUidMap[ns]).filter(ip => this.ipUidMap[ns][ip] === uid);
  }
}

const instance = new IdentityManager();
module.exports = instance;
