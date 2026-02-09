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
const DomainIPTool = require('./DomainIPTool.js');
const domainIPTool = new DomainIPTool();
const firewalla = require('../net2/Firewalla.js');
const _ = require('lodash')
const LRU = require('lru-cache');

const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('../net2/Message.js');

const exec = require('util').promisify(require('child_process').exec);
const Constants = require('../net2/Constants.js');

let categoryUpdater = null;

const CONNMARK_REFRESH_INTERVAL = 15 * 1000; // 15 seconds
var instance = null;

class DomainUpdater {
  constructor() {
    if (instance == null) {
      this.updateOptions = {};
      this.connUpdateOptions = {}; // options for connection ipset update
      instance = this;
      this._needRefresh = false;

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
        if (this._needRefresh) {
          log.debug("DomainUpdater refreshing connmark for updated ipsets");
          await this.scheduleRefreshConnmark();
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
          await Block.batchBlockConnection([connection], connSet, options).catch((err) => {
            log.error(`Failed to update domain connection ipset ${connSet} for ${domain}`, err.message);
          });

          this._needRefresh = true;

        }
      }
    }

  }

  async scheduleRefreshConnmark() {
    if (this._refreshConnmarkTimeout)
      clearTimeout(this._refreshConnmarkTimeout);
    this._refreshConnmarkTimeout = setTimeout(async () => {
      // use conntrack to clear the first bit of connmark on existing connections
      await exec(`sudo conntrack -U -m 0x00000000/0x80000000`).catch((err) => {
        // log.warn(`Failed to clear first bit of connmark on existing IPv4 connections`, err.message);
      });
      await exec(`sudo conntrack -U -f ipv6 -m 0x00000000/0x80000000`).catch((err) => {
        // log.warn(`Failed to clear first bit of connmark on existing IPv6 connections`, err.message);
      });
    }, 5000);
  }


  registerUpdate(domain, options) {
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
      // a secondary index for domain update options
      if (!this.updateOptions[domainKey])
        this.updateOptions[domainKey] = {};
      // use mapping key to uniquely identify each domain mapping settings
      const key = domainIPTool.getDomainIPMappingKey(domain, options);
      config.ipCache = new LRU({maxAge: options.ipttl * 1000 / 2 || 0}); // invalidate the entry in lru earlier than its ttl so that it can be re-added to the underlying ipset
      this.updateOptions[domainKey][key] = config;
    }
    if (options.connSet) {
      if (!this.connUpdateOptions[domainKey])
        this.connUpdateOptions[domainKey] = {};
      const key = domainIPTool.getDomainConnMappingKey(domain, options);
      log.debug(`DomainUpdater registerUpdate connection ipset for domain ${domain} with key ${key}, options`, options);
      this.connUpdateOptions[domainKey][key] = config;
    }
  }

  unregisterUpdate(domain, options) {
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
      const key = domainIPTool.getDomainIPMappingKey(domain, options);
      if (this.updateOptions[domainKey] && this.updateOptions[domainKey][key])
        delete this.updateOptions[domainKey][key];
    }
    
    if (options.connSet) {
      const key = domainIPTool.getDomainConnMappingKey(domain, options);
      log.debug(`DomainUpdater unregisterUpdate for domain ${domain} with key:${key}, options`, options);
      if (this.connUpdateOptions[domainKey] && this.connUpdateOptions[domainKey][key])
        delete this.connUpdateOptions[domainKey][key];
    }
  }

  async updateDomainMapping(domain, addresses) {
    if (!_.isString(domain)) return;

    const parentDomains = this.getParentDomains(domain);

    for (const domainKey of parentDomains) {
      if (!this.updateOptions[domainKey])
        continue;
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
          const existingAddresses = await domainIPTool.getMappedIPAddresses(d, options);
          const existingSet = {};
          existingAddresses.forEach((addr) => {
            existingSet[addr] = 1;
          });
          addresses = addresses.filter((addr) => { // ignore reserved blocking ip addresses
            return firewalla.isReservedBlockingIP(addr) != true;
          });
          let blockSet = "block_domain_set";
          let updateIpsetNeeded = false;
          if (options.blockSet)
            blockSet = options.blockSet;
          const ipttl = options.ipttl || null;

          for (let i in addresses) {
            const address = addresses[i];
            if (!existingSet[address] || (Number.isInteger(ipttl) && ipCache && !ipCache.get(address))) {
              updateIpsetNeeded = true;
              ipCache && ipCache.set(address, 1);
              await rclient.saddAsync(key, address);
            }
          }
          if (updateIpsetNeeded) {
            // add comment string to ipset, @ to indicate dynamically updated.
            if (options.needComment) {
              options.comment = `${domain}@`;
            }
            if (options.port) {
              await Block.batchBlockNetPort(addresses, options.port, blockSet, options).catch((err) => {
                log.error(`Failed to batch update domain ipset ${blockSet} for ${domain}`, err.message);
              });
            } else {
              await Block.batchBlock(addresses, blockSet, options).catch((err) => {
              log.error(`Failed to batch update domain ipset ${blockSet} for ${domain}`, err.message);
            });
            }
          }
        }
      }
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
