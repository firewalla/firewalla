/*    Copyright 2021 Firewalla Inc
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
const PolicyManager = require('./PolicyManager.js');
const sysManager = require('./SysManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const pm = new PolicyManager();
const f = require('./Firewalla.js');
const exec = require('child-process-promise').exec;
const { Address4, Address6 } = require('ip-address');
const Message = require('./Message.js');

const Promise = require('bluebird');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
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
    this.iptablesReady = false;
    this.loadIdentityClasses();

    this.scheduleRefreshIdentities();
    if (f.isMain()) {
      sem.once('IPTABLES_READY', async () => {
        this.iptablesReady = true;
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
            if (f.isMain() && this.iptablesReady) {
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
        if (this.iptablesReady) {
          log.info(`Destroying environment for identity ${ns} ${identity.getUniqueId()} ...`);
          await identity.destroyEnv();
        } else {
          sem.once('IPTABLES_READY', async () => {
            log.info(`Destroying environment for identity ${ns} ${identity.getUniqueId()} ...`);
            await identity.destroyEnv();
          });
        }
      }
      for (const identity of newIdentities) {
        if (this.iptablesReady) {
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
    this.allIdentities[ns] = currentIdentities;
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
            if (f.isMain() && this.iptablesReady) {
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
    for (const ns of Object.keys(this.ipUidMap)) {
      const ipUidMap = this.ipUidMap[ns];
      if (ipUidMap[ip]) {
        const uid = ipUidMap[ip];
        if (this.allIdentities[ns] && this.allIdentities[ns][uid])
          return this.allIdentities[ns][uid];
      }
    }
    return null;
  }

  getEndpointByIP(ip) {
    for (const ns of Object.keys(this.ipEndpointMap)) {
      const ipEndpointMap = this.ipEndpointMap[ns];
      if (ipEndpointMap[ip])
        return ipEndpointMap[ip];
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
    for (const ns of nss) {
      const c = this.nsClassMap[ns];
      const key = c.getKeyOfInitData();
      const data = await c.getInitData();
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
}

const instance = new IdentityManager();
module.exports = instance;