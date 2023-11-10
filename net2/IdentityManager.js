/*    Copyright 2021-2023 Firewalla Inc.
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
const asyncNative = require('../util/asyncNative.js');
const rclient = require('../util/redis_manager.js').getRedisClient()
const Identity = require('./Identity.js')

const Promise = require('bluebird');
const _ = require('lodash');
const fs = require('fs');
const CIDRTrie = require('../util/CIDRTrie.js');
Promise.promisifyAll(fs);


class IdentityManager {
  constructor() {
    this.allIdentities = {};
    this.nsClassMap = {};
    this.ipUidMap = {};
    this.cidr4TrieMap = {};
    this.cidr6TrieMap = {};
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

    this.initialized = {}
    for (const ns of Object.keys(this.nsClassMap)) {
      this.initialized[ns] = false
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
      if (!this.cidr4TrieMap.hasOwnProperty(ns))
        this.cidr4TrieMap[ns] = new CIDRTrie(4);
      if (!this.cidr6TrieMap.hasOwnProperty(ns))
        this.cidr6TrieMap[ns] = new CIDRTrie(6);
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
    const flowManager = new FlowManager();
    const guid = identity.getGUID();
    await pm2.deleteMacRelatedPolicies(guid);
    await em.deleteMacRelatedExceptions(guid);
    await am2.deleteMacRelatedAlarms(guid);
    await categoryFlowTool.delAllTypes(guid);
    await flowAggrTool.removeAggrFlowsAll(guid);
    await flowManager.removeFlowsAll(guid);
    await rclient.unlinkAsync(`neighbor:${guid}`);
    await rclient.unlinkAsync(`host:user_agent2:${guid}`);
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
            this.initialized[ns] = true
          } catch (err) {
            log.error(`Failed to refresh Identity of ${ns}`, err);
          } finally {
            this._refreshIdentityInProgress[ns] = false;
          }
        }
      }, 3000);
    }
  }

  isInitialized() {
    for (const ns in this.nsClassMap) {
      if (!ns in this.initialized) {
        log.error('Initialized map mismatch with nsClassMap', ns)
        return false
      }
      if (!this.initialized[ns]) return false
    }
    return true
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
        (async () => {
          await sysManager.waitTillIptablesReady()
          log.info(`Destroying environment for identity ${ns} ${identity.getUniqueId()} ...`);
          await this.cleanUpIdentityData(identity);
          await identity.destroyEnv();
          await identity.destroy();
        })()
      }
      for (const identity of newIdentities) {
        (async () => {
          await sysManager.waitTillIptablesReady()
          log.info(`Creating environment for identity ${ns} ${identity.getUniqueId()} ...`);
          await identity.createEnv();
        })()
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

    const allCidrs = _.uniq(Object.keys(ipUidMap).concat(Object.keys(ipEndpointMap)));
    const cidr4Trie = new CIDRTrie(4);
    const cidr6Trie = new CIDRTrie(6);
    for (const cidr of allCidrs) {
      const uid = ipUidMap[cidr];
      const endpoint = ipEndpointMap[cidr];
      if (new Address4(cidr).isValid()) {
        cidr4Trie.add(cidr, {uid, endpoint});
      } else {
        if (new Address6(cidr).isValid()) {
          cidr6Trie.add(cidr, {uid, endpoint});
        }
      }
    }
    this.cidr4TrieMap[ns] = cidr4Trie;
    this.cidr6TrieMap[ns] = cidr6Trie;
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
    // Slow path. Match argument ip using CIDRTrie
    if (new Address4(ip).isValid()) {
      for (const ns of Object.keys(this.cidr4TrieMap)) {
        const cidr4Trie = this.cidr4TrieMap[ns];
        const val = cidr4Trie.find(ip);
        if (val && val.uid) {
          return this.getIdentity(ns, val.uid);
        }
      }
    } else {
      if (new Address6(ip).isValid()) {
        for (const ns of Object.keys(this.cidr6TrieMap)) {
          const cidr6Trie = this.cidr6TrieMap[ns];
          const val = cidr6Trie.find(ip);
          if (val && val.uid) {
            return this.getIdentity(ns, val.uid);
          }
        }
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
    // Slow path. Match argument ip using CIDRTrie
    if (new Address4(ip).isValid()) {
      for (const ns of Object.keys(this.cidr4TrieMap)) {
        const cidr4Trie = this.cidr4TrieMap[ns];
        const val = cidr4Trie.find(ip);
        if (val && val.endpoint) {
          return val.endpoint;
        }
      }
    } else {
      if (new Address6(ip).isValid()) {
        for (const ns of Object.keys(this.cidr6TrieMap)) {
          const cidr6Trie = this.cidr6TrieMap[ns];
          const val = cidr6Trie.find(ip);
          if (val && val.endpoint) {
            return val.endpoint;
          }
        }
      }
    }
    return null;
  }

  getIdentities(ns) {
    return this.allIdentities[ns];
  }

  getAllIdentities() {
    return this.allIdentities;
  }

  forEachAll(f) {
    for (const ns of Object.keys(this.allIdentities)) {
      const identities = this.allIdentities[ns];
      for (const uid of Object.keys(identities)) {
        if (identities[uid])
          f(identities[uid], uid, ns)
      }
    }
  }

  getAllIdentitiesFlat() {
    const results = []
    this.forEachAll(identity => results.push(identity))
    return results
  }

  getGUID(identity) {
    return identity.getGUID()
  }

  getNSAndUID(guid) {
    if (!this.isGUID(guid))
      return null;
    const [ns, uid] = guid && guid.split(':', 2);
    return { ns, uid };
  }

  getIdentityClassByGUID(guid) {
    if (!this.isGUID(guid))
      return null;
    const [ns, uid] = guid && guid.split(':', 2);
    return this.nsClassMap[ns];
  }

  getAllIdentitiesGUID() {
    const guids = [];
    this.forEachAll(identity => guids.push(identity.getGUID()))
    return guids;
  }

  async generateInitData(json, nss) {
    nss = _.isArray(nss) ? nss : Object.keys(this.nsClassMap);
    const HostManager = require('./HostManager.js');
    const hostManager = new HostManager();
    await Promise.all(nss.map(async ns => {
      const c = this.nsClassMap[ns];
      const key = c.getKeyOfInitData();
      const data = await c.getInitData();
      log.debug('init data finished for', ns)
      if (_.isArray(data)) {
        await asyncNative.eachLimit(data, 30, async e => {
          if (e.uid) {
            const guid = `${c.getNamespace()}:${e.uid}`;
            const stats = await hostManager.getStats({ granularities: '1hour', hits: 24 }, guid, ['upload', 'download']);
            e.flowsummary = {
              inbytes: stats.totalDownload,
              outbytes: stats.totalUpload
            }
            await hostManager.enrichWeakPasswordScanResult(e, guid);
          }
        })
      }
      json[key] = data;
    }))
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

  async loadPolicyRules() {
    await asyncNative.eachLimit(this.getAllIdentitiesFlat(), 10, id => id.loadPolicyAsync())
  }
}

const instance = new IdentityManager();
module.exports = instance;
