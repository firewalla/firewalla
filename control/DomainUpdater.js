/*    Copyright 2016-2023 Firewalla Inc.
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

const log = require("../net2/logger.js")(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient()

const Block = require('./Block.js');
const blockControl = require('./BlockControl.js');
const DomainIPTool = require('./DomainIPTool.js');
const domainIPTool = new DomainIPTool();
const firewalla = require('../net2/Firewalla.js');
const _ = require('lodash')
const LRU = require('lru-cache');

const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('../net2/Message.js');

const Constants = require('../net2/Constants.js');


let categoryUpdater = null;

const CONNMARK_REFRESH_INTERVAL = 15 * 1000; // 15 seconds
// backstop only: one pending job per domain means a box would need this many covered domains
// resolving at once to reach it. dropping is not free - BroDetect holds identical DNS answers in
// an LRU for an hour, so a dropped mapping is not necessarily re-sent soon - hence the error log
const MAX_PENDING_MAPPINGS = 20000;
// and one domain cannot grow a single pending job without bound either
const MAX_ADDRESSES_PER_MAPPING = 1000;
// what actually bounds the memory: a wildcard registration covers every subdomain, so the number
// of domains with a pending job is not bounded by the rules, only by this
const MAX_QUEUED_ADDRESSES = 50000;
var instance = null;

class DomainUpdater {
  constructor() {
    if (instance == null) {
      this.updateOptions = {};
      this.connUpdateOptions = {}; // options for connection ipset update
      instance = this;
      this._needRefresh = false;
      this._priorityJobQueue = []; // registerUpdate / unregisterUpdate
      // clearIPCacheForDomain and anything else enqueued at standard priority. a Map, not an
      // array: it dequeues without Array.shift(), which is O(queue length)
      this._standardJobs = new Map();
      // one entry per domain, in insertion order, so repeated answers for the same domain merge
      // instead of piling up. kept apart from _standardJobs because only these can be dropped,
      // and a category recycle can leave thousands of clear jobs in front of them
      this._pendingMappings = new Map();
      this._jobSeq = 0;
      this._droppedJobs = 0;
      this._droppedAddresses = 0;
      this._queuedAddresses = 0;
      this._processorRunning = false;

      sem.on('Domain:Flush', async () => {
        try {
          await this.flush()
          log.info('Domain:Flush done')
        } catch(err) {
          log.error('Domain:Flush failed', err)
        }
      });

      // BroDetect -> DestIPFoundHook -> here
      sem.on(Message.MSG_FLOW_ENRICHED, async (event) => {
        if (event && !_.isEmpty(event.flow))
          await this.updateConnectIpset(event.flow).catch((err) => {
            log.error(`Failed to process enriched flow`, event.flow, err.message);
          });
      });

      setInterval(async () => {
        log.debug(`_priorityJobQueue.length:${this._priorityJobQueue.length}, _standardJobs.size:${this._standardJobs.size}, _pendingMappings.size:${this._pendingMappings.size}, _queuedAddresses:${this._queuedAddresses}`);
        if (this._droppedJobs > 0 || this._droppedAddresses > 0) {
          log.error(`Dropped ${this._droppedJobs} domain mappings and ${this._droppedAddresses} addresses, over ${MAX_PENDING_MAPPINGS} pending mappings, ${MAX_QUEUED_ADDRESSES} queued addresses or ${MAX_ADDRESSES_PER_MAPPING} for one domain`);
          this._droppedJobs = 0;
          this._droppedAddresses = 0;
        }
        if (this._needRefresh) {
          log.debug("DomainUpdater refreshing connmark for updated ipsets");
          blockControl.scheduleRefreshConnmark();
          this._needRefresh = false;
        }
      }, CONNMARK_REFRESH_INTERVAL);
    }
    return instance;
  }

  isFlowMatchWithDomainOptions(flow, options) {
    if (!flow || !options)
      return false;

    if (options.devOpts) {
      if (_.isEmpty(options.devOpts.tags) && _.isEmpty(options.devOpts.intfs) && _.isEmpty(options.devOpts.scope) && _.isEmpty(options.devOpts.guids)) {
        // this is a global device type/value blocking, no need to check device info
        return true;
      }

      if (!_.isEmpty(options.devOpts.tags)) {
        // check if any tag matches
        for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
          const config = Constants.TAG_TYPE_MAP[type];
          if (flow[config.flowKey] && options.devOpts.tags.some(r => flow[config.flowKey].includes(r))) {
            return true;
          }
        }
      }
      
      if (!_.isEmpty(options.devOpts.intfs)) {
        // check if any intf matches
        if (flow.intf && options.devOpts.intfs.includes(flow.intf))
          return true;
      }

      if (!_.isEmpty(options.devOpts.scope)) {
        // check if scope matches
        if (flow.mac && options.devOpts.scope.includes(flow.mac))
          return true;
      }

      if (!_.isEmpty(options.devOpts.guids)) {
        // check if any guid matches
        if (flow.guid && options.devOpts.guids.includes(flow.guid))
          return true;
      }
    }
    if (options.category) {
      // check if any category matches the device type/value
      if (categoryUpdater == null) {
        const CategoryUpdater = require('../control/CategoryUpdater.js');
        categoryUpdater = new CategoryUpdater();
      }

      const devOpts = {};
      const tmpTags = [];
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const config = Constants.TAG_TYPE_MAP[type];
        if (flow[config.flowKey])
          tmpTags.push(...flow[config.flowKey]);
      }
      devOpts.tags = tmpTags;
      if (flow.intf)
        devOpts.intfs = [flow.intf];
      if (flow.mac)
        devOpts.scope = [flow.mac];
      if (flow.guid)
        devOpts.guids = [flow.guid];
      if (categoryUpdater.isDevBlockedByCategory(options.category, devOpts))
        return true;
    }
    return false;
  }

  getParentDomains(domain) {
    const parentDomains = [domain];
    for (let i = 0; i < domain.length; i++) {
      if (domain[i] === '.') {
        while (domain[i] === '.' && i < domain.length)
          i++;
        if (i < domain.length)
          parentDomains.push(domain.substring(i));
      }
    }
    return parentDomains;
  }

  async updateConnectIpset(flow) {
    // get connection info from enriched flow message
    // and check if need add to crossponding connection ipset
    if (!flow || !flow.lh || !flow.ip || !flow.sp || !flow.dp || !flow.pr || !flow.sh)
      return;

    const connection = {
      localAddr: flow.lh,
      remoteAddr: flow.ip,
      protocol: flow.pr,
      localPorts: flow.sp,
      remotePorts: flow.dp
    };


    const domain = flow.host || flow.intel && flow.intel.host;
    if (!domain) {
      return; // skip if host info is not available
    }

    if (flow.lh != flow.sh) {
      connection.localPorts = flow.dp;
      connection.remotePorts = flow.sp;
    }

    if (firewalla.isReservedBlockingIP(connection.remoteAddr)) {
      log.debug("DomainUpdater skip flow due to reserved blocking ip", connection.remoteAddr);
      return;
    }

    const parentDomains = this.getParentDomains(domain);

    for (const domainKey of parentDomains) {
      if (!this.connUpdateOptions[domainKey])
        continue;
      for (const key in this.connUpdateOptions[domainKey]) {
        const config = this.connUpdateOptions[domainKey][key];
        const d = config.domain;
        const options = config.options;
        if (!options.connSet)
            continue;
        if (domain.toLowerCase() === d.toLowerCase()
          || !options.exactMatch && domain.toLowerCase().endsWith("." + d.toLowerCase())) {

          const connSet = options.connSet;

          if (options.port) {
            // check if the connection remote port matches the port info in options
            if (options.port.proto != connection.protocol ||
                options.port.start > connection.remotePorts ||
                options.port.end < connection.remotePorts)
              continue;
          }

          if (!this.isFlowMatchWithDomainOptions(flow, options)) {
            log.debug(`DomainUpdater skip flow due to device info not match`, flow, options.devOpts);
            continue;
          }
          
          // add comment string to ipset, @ to indicate dynamically updated.
          if (options.needComment) {
            options.comment = `${domain}@`;
          }

          log.debug(`DomainUpdater updating connection ipset ${connSet} for domain ${domain}`, connection);
          await Block.batchBlockConnection([connection], connSet, options)

          this._needRefresh = true;

        }
      }
    }

  }

  _dequeueNextJob() {
    if (this._priorityJobQueue.length > 0)
      return this._priorityJobQueue.shift();
    // standard jobs before mappings: clearIPCacheForDomain is synchronous and drains at once,
    // and a mapping running after a clear re-adds its addresses, which is what the clear is for
    for (const queue of [this._standardJobs, this._pendingMappings]) {
      const next = queue.keys().next();
      if (next.done)
        continue;
      const entry = queue.get(next.value);
      // taken out before it runs, so an answer arriving meanwhile starts a new entry instead of
      // being merged into the one already in flight
      queue.delete(next.value);
      if (entry.addresses)
        this._queuedAddresses -= entry.addresses.size;
      return entry;
    }
    return null;
  }

  // a standard job with a dedupeKey that is already pending is not queued again: the caller
  // shares the pending job's promise
  _enqueueJob(fn, highPriority, dedupeKey) {
    if (!highPriority && dedupeKey) {
      const pending = this._standardJobs.get(dedupeKey);
      if (pending)
        return pending.promise;
    }
    const entry = { fn };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolvers = [resolve];
      entry.rejecters = [reject];
    });
    if (highPriority)
      this._priorityJobQueue.push(entry);
    else
      this._standardJobs.set(dedupeKey || `j${this._jobSeq++}`, entry);
    this._kickJobProcessor();
    return entry.promise;
  }

  // the oldest first, and only mappings: a clearIPCacheForDomain would never come back
  _dropOverflowJobs() {
    while (this._pendingMappings.size > MAX_PENDING_MAPPINGS || this._queuedAddresses > MAX_QUEUED_ADDRESSES) {
      const key = this._pendingMappings.keys().next().value;
      if (key === undefined)
        return;
      const entry = this._pendingMappings.get(key);
      this._pendingMappings.delete(key);
      this._queuedAddresses -= entry.addresses.size;
      for (const resolve of entry.resolvers)
        resolve();
      this._droppedJobs++;
    }
  }

  // the parent domains of `domain` that something registered an update for. both the enqueue
  // check and the job itself go through this, so they cannot disagree about what matches.
  // walks the domain itself rather than reusing getParentDomains: this runs on every DNS
  // answer, and that one builds an array of every parent whether it is registered or not
  _registeredParentKeys(domain) {
    const keys = [];
    if (this.updateOptions[domain])
      keys.push(domain);
    for (let i = domain.indexOf('.'); i >= 0 && i + 1 < domain.length; i = domain.indexOf('.', i + 1)) {
      const parent = domain.substring(i + 1);
      if (this.updateOptions[parent])
        keys.push(parent);
    }
    return keys;
  }

  _kickJobProcessor() {
    if (this._processorRunning)
      return;
    this._processorRunning = true;
    const processNext = async () => {
      let job;
      while ((job = this._dequeueNextJob()) != null) {
        const { fn, resolvers, rejecters } = job;
        try {
          await fn();
          for (const resolve of resolvers)
            resolve();
        } catch (err) {
          for (const reject of rejecters)
            reject(err);
        }
      }
      this._processorRunning = false;
      if (this._priorityJobQueue.length > 0 || this._standardJobs.size > 0 || this._pendingMappings.size > 0)
        this._kickJobProcessor();
    };
    processNext();
  }

  async registerDomainOnlyUpdate(domain, options) {
    log.debug(`DomainUpdater registerDomainOnlyUpdate for domain ${domain} with options`, options);
    const domainKey = domain.startsWith("*.") ? domain.toLowerCase().substring(2) : domain.toLowerCase();
    if (domain.startsWith("*.")) {
      options.exactMatch = false;
      domain = domain.substring(2);
    }
    const config = {domain: domain, options: options};
    if (!this.connUpdateOptions[domainKey])
      this.connUpdateOptions[domainKey] = {};
    const key = domainIPTool.getDomainConnMappingKey(domain, options);
    log.debug(`DomainUpdater registerDomainOnlyUpdate for domain ${domain} with key ${key}, options`, options);
    this.connUpdateOptions[domainKey][key] = config;
  }

  async unregisterDomainOnlyUpdate(domain, options) {
    log.debug(`DomainUpdater unregisterDomainOnlyUpdate for domain ${domain} with options`, options);
    const domainKey = domain.startsWith("*.") ? domain.toLowerCase().substring(2) : domain.toLowerCase();
    if (domain.startsWith("*.")) {
      options.exactMatch = false;
      domain = domain.substring(2);
    }
    const key = domainIPTool.getDomainConnMappingKey(domain, options);
    log.debug(`DomainUpdater unregisterUpdate for domain ${domain} with key:${key}, options`, options);
    if (this.connUpdateOptions[domainKey] && this.connUpdateOptions[domainKey][key])
      delete this.connUpdateOptions[domainKey][key];
  }

  async registerDefaultUpdate(domain, options) {
    log.debug(`DomainUpdater registerDefaultUpdate for domain ${domain} with options`, options);
    const domainKey = domain.startsWith("*.") ? domain.toLowerCase().substring(2) : domain.toLowerCase();
    if (domain.startsWith("*.")) {
      options.exactMatch = false;
      domain = domain.substring(2);
    }
    const config = {domain: domain, options: options};
    // a secondary index for domain update options
    if (!this.updateOptions[domainKey])
      this.updateOptions[domainKey] = {};
    // use mapping key to uniquely identify each domain mapping settings
    const key = domainIPTool.getDomainIPMappingKey(domain, options);
    config.ipCache = new LRU({maxAge: options.ipttl * 1000 / 2 || 600000}); // invalidate the entry in lru earlier than its ttl so that it can be re-added to the underlying ipset
    this.updateOptions[domainKey][key] = config;
  }

  async unregisterDefaultUpdate(domain, options) {
    log.debug(`DomainUpdater unregisterDefaultUpdate for domain ${domain} with options`, options);
    const domainKey = domain.startsWith("*.") ? domain.toLowerCase().substring(2) : domain.toLowerCase();
    if (domain.startsWith("*.")) {
      options.exactMatch = false;
      domain = domain.substring(2);
    }

    const key = domainIPTool.getDomainIPMappingKey(domain, options);
    if (this.updateOptions[domainKey] && this.updateOptions[domainKey][key]) {
      delete this.updateOptions[domainKey][key];
      // an empty bucket still reads as a registration, so every answer for a domain policy has
      // dropped would keep being queued for a job with nothing to do
      if (_.isEmpty(this.updateOptions[domainKey]))
        delete this.updateOptions[domainKey];
    }
  }
  
  // one pending clear per registration: back-to-back category recycles would otherwise queue
  // one job per domain each time
  clearIPCacheForDomain(domain, options) {
    // the key is built here, not in the job, so a bad domain must not throw into the caller's loop
    if (!_.isString(domain))
      return Promise.resolve();
    const { domainKey, key } = this._clearTarget(domain, options);
    return this._enqueueJob(() => this._clearIPCacheForDomain(domainKey, key), false, `clear:${domainKey}:${key}`);
  }

  // Mirrors registerDefaultUpdate: exactMatch is derived from the domain pattern.
  _clearTarget(domain, options) {
    const domainKey = domain.startsWith("*.") ? domain.toLowerCase().substring(2) : domain.toLowerCase();
    const exactMatch = !domain.startsWith("*.");
    const key = domainIPTool.getDomainIPMappingKey(domainKey, { ...options, exactMatch });
    return { domainKey, key };
  }

  // Clear ipCache for a specific domain registration so that DomainUpdater
  // re-adds IPs after the underlying ipset has been flushed or swapped out by
  // recycleIPSet without going through DomainUpdater.
  _clearIPCacheForDomain(domainKey, key) {
    const config = this.updateOptions[domainKey] && this.updateOptions[domainKey][key];
    if (config && config.ipCache) {
      config.ipCache.reset();
    }
  }

  async _registerUpdate(domain, options) {
    log.debug(`DomainUpdater registerUpdate for domain ${domain} with options`, options);
    const domainKey = domain.startsWith("*.") ? domain.toLowerCase().substring(2) : domain.toLowerCase();

    if (domain.startsWith("*.")) {
      options.exactMatch = false;
      domain = domain.substring(2);
    }

    const config = {domain: domain, options: options};
    let domainOnly = false; // default to domain-only false
    if ( options.domainOnly === true) {
      domainOnly = true;
    }
    if (!domainOnly) {
      await this.registerDefaultUpdate(domain, options);
    }

    if (options.connSet) {
      await this.registerDomainOnlyUpdate(domain, options);
    }
  }

  registerUpdate(domain, options) {
    return this._enqueueJob(() => this._registerUpdate(domain, options), true);
  }

  async _unregisterUpdate(domain, options) {
    const domainKey = domain.startsWith("*.") ? domain.toLowerCase().substring(2) : domain.toLowerCase();
    if (domain.startsWith("*.")) {
      options.exactMatch = false;
      domain = domain.substring(2);
    }
    
    let domainOnly = false; // default to domain-only false
    if ( options.domainOnly === true) {
      domainOnly = true;
    }

    if (!domainOnly) {
      await this.unregisterDefaultUpdate(domain, options);
    }
    
    if (options.connSet) {
      await this.unregisterDomainOnlyUpdate(domain, options);
    }
  }

  unregisterUpdate(domain, options) {
    return this._enqueueJob(() => this._unregisterUpdate(domain, options), true);
  }

  async _updateDomainMapping(domain, addresses) {
    if (!_.isString(domain)) return;

    const parentDomains = this._registeredParentKeys(domain);

    for (const domainKey of parentDomains) {
      const DNSTool = require("../net2/DNSTool.js");
      const dnsTool = new DNSTool();

      for (const key in this.updateOptions[domainKey]) {
        const config = this.updateOptions[domainKey][key];
        const d = config.domain;
        const options = config.options;
        
        const ipCache = config.ipCache || null;

        if (domain.toLowerCase() === d.toLowerCase()
          || !options.exactMatch && domain.toLowerCase().endsWith("." + d.toLowerCase())) {
          if (!options.exactMatch) {
            await dnsTool.addSubDomains(d, [domain]);
          }
          let blockSet = "block_domain_set";
          if (options.blockSet)
            blockSet = options.blockSet;

          let newAddresses = [];
          for (let i in addresses) {
            const address = addresses[i];
            if (firewalla.isReservedBlockingIP(address) === true) {
              continue;
            }
            if (ipCache && ipCache.get(address) === 1) {
              continue;
            }
            newAddresses.push(address);
          }
          if (newAddresses.length === 0) {
            continue;
          }

          const existingAddresses = await domainIPTool.getMappedIPAddresses(d, options);
          const existingSet = {};
          existingAddresses.forEach((addr) => {
            existingSet[addr] = 1;
          });

          const unmappedAddresses = newAddresses.filter((address) => !existingSet[address]);
          // one round trip instead of one per address: this runs on every DNS answer that
          // matches a rule, and the job queue is strictly serial
          if (unmappedAddresses.length > 0) {
            await rclient.saddAsync(key, unmappedAddresses);
          }
          // cached only once redis has them: a failure above must leave the next answer free to
          // retry, and a cached address that was never stored is invisible for half its ttl
          if (ipCache) {
            for (const address of newAddresses)
              ipCache.set(address, 1);
          }
          log.debug(`DomainUpdater updateDomainMapping for domain ${domain} with filteredaddresses: ${newAddresses}, original addresses: ${addresses}`);
          // add comment string to ipset, @ to indicate dynamically updated.
          if (options.needComment) {
            options.comment = `${domain}@`;
          }
          if (options.port) {
            await Block.batchBlockNetPort(newAddresses, options.port, blockSet, options, true).catch((err) => {
              log.error(`Failed to batch update domain ipset ${blockSet} for ${domain}`, err.message);
            });
          } else {
            await Block.batchBlock(newAddresses, blockSet, options, true).catch((err) => {
              log.error(`Failed to batch block domain ${domain} in ${blockSet}`, err.message);
            });
          }
          
        }
      }
    }
  }

  updateDomainMapping(domain, addresses) {
    if (!_.isString(domain) || _.isEmpty(addresses))
      return Promise.resolve();
    // most DNS answers are for domains no rule covers. a registerUpdate still in the priority
    // queue could add this very domain, so only skip while none is waiting
    if (this._priorityJobQueue.length === 0 && this._registeredParentKeys(domain).length === 0)
      return Promise.resolve();

    const pending = this._pendingMappings.get(domain);
    if (pending) {
      this._mergeAddresses(pending, addresses);
      // merging grows the address budget too, so it has to answer for it like a new entry
      this._dropOverflowJobs();
      // the same promise, not one more per answer: a merge has to cost nothing to be worth it
      return pending.promise;
    }

    const entry = { addresses: new Set(), rejecters: [] };
    this._mergeAddresses(entry, addresses);
    entry.promise = new Promise((resolve) => { entry.resolvers = [resolve]; });
    // caught here rather than rejected: the caller does not await this, and an unhandled
    // rejection on a DNS answer would reach the cloud through main.js's handler
    entry.fn = () => this._updateDomainMapping(domain, Array.from(entry.addresses))
      .catch((err) => log.error(`Failed to update domain mapping for ${domain}`, err.message));
    this._pendingMappings.set(domain, entry);
    this._dropOverflowJobs();
    this._kickJobProcessor();
    return entry.promise;
  }

  // one domain's pending job cannot grow without bound either, however fast its answers rotate
  _mergeAddresses(entry, addresses) {
    for (const address of addresses) {
      if (entry.addresses.size >= MAX_ADDRESSES_PER_MAPPING) {
        this._droppedAddresses++;
        continue;
      }
      if (entry.addresses.has(address))
        continue;
      entry.addresses.add(address);
      this._queuedAddresses++;
    }
  }

  async flush() {
    // for (const domainKey of this.updateOptions) {
    //   for (const key of this.updateOptions[domainKey]) {
    //     this.updateOptions[domainKey][key].ipCache.clear()
    //   }
    // }
    this.updateOptions = {}

    const ipmappingKeys = await rclient.scanResults('ipmapping:*')
    ipmappingKeys.length && await rclient.unlinkAsync(ipmappingKeys)
  }
}

module.exports = DomainUpdater;
