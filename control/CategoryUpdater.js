/*    Copyright 2016 Firewalla LLC
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
const Promise = require('bluebird');

const rclient = require('../util/redis_manager.js').getRedisClient()

const Block = require('./Block.js');

const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()

const domainBlock = require('../control/DomainBlock.js')();

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bone = require('../lib/Bone.js')

const fc = require('../net2/config.js')

const exec = require('child-process-promise').exec

let instance = null

const EXPIRE_TIME = 60 * 60 * 48 // one hour

const _ = require('underscore')

const redirectHttpPort = 8880;
const redirectHttpsPort = 8883;
const blackHoleHttpPort = 8881;
const blackHoleHttpsPort = 8884;
const blockHttpPort = 8882;
const blockHttpsPort = 8885;

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

class CategoryUpdater {

  constructor() {
    if (instance == null) {
      instance = this
      this.activeCategories = {
        "games": 1,
        "social": 1,
        "porn": 1,
        "shopping": 1,
        "av": 1,
        "default_c": 1
      }

      // only run refresh category records for fire main process
      if(process.title === 'FireMain') {
        setInterval(() => {
          this.refreshAllCategoryRecords()
        }, 60 * 60 * 1000) // update records every hour

        setTimeout(() => {

          (async () => {
            log.info("============= UPDATING CATEGORY IPSET =============")
            await this.refreshAllCategoryRecords()
            log.info("============= UPDATING CATEGORY IPSET COMPLETE =============")
          })()

        }, 2 * 60 * 1000) // after two minutes
        
        sem.on('UPDATE_CATEGORY_DYNAMIC_DOMAIN', (event) => {
          if(event.category) {
            this.recycleIPSet(event.category)    
          }
        });
      }
    }
    return instance
  }

  getCategoryKey(category) {
    return `dynamicCategoryDomain:${category}`
  }

  getExcludeCategoryKey(category) {
    return `category:${category}:exclude:domain`
  }

  getIncludeCategoryKey(category){
    return `category:${category}:include:domain`
  }

  getDefaultCategoryKey(category){
    return `category:${category}:default:domain`
  }

  getIPv4CategoryKey(category) {
    return `category:${category}:ip4:domain`
  }

  getIPv6CategoryKey(category) {
    return `category:${category}:ip6:domain`
  }

  async getDomains(category) {
    if(!this.isActivated(category))
      return []

    return rclient.zrangeAsync(this.getCategoryKey(category), 0, -1)
  }

  async getDefaultDomains(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getDefaultCategoryKey(category))
  }

  async addDefaultDomains(category, domains) {
    if(!this.isActivated(category))
      return []

    if(domains.length === 0) {
      return []
    }

    let commands = [this.getDefaultCategoryKey(category)]

    commands.push.apply(commands, domains)
    return rclient.saddAsync(commands)
  }

  async flushDefaultDomains(category) {
    if(!this.isActivated(category))
      return [];

    return rclient.delAsync(this.getDefaultCategoryKey(category));
  }

  async getIPv4Addresses(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getIPv4CategoryKey(category))
  }

  async getIPv4AddressesCount(category) {
    if(!this.isActivated(category))
      return 0

    return rclient.scardAsync(this.getIPv4CategoryKey(category))
  }

  async addIPv4Addresses(category, addresses) {
    if(!this.isActivated(category))
      return []

    if(addresses.length === 0) {
      return []
    }

    let commands = [this.getIPv4CategoryKey(category)]

    commands.push.apply(commands, addresses)
    return rclient.saddAsync(commands)
  }

  async flushIPv4Addresses(category) {
    if(!this.isActivated(category))
      return [];

    return rclient.delAsync(this.getIPv4CategoryKey(category));
  }


  async getIPv6Addresses(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getIPv6CategoryKey(category))
  }

  async getIPv6AddressesCount(category) {
    if(!this.isActivated(category))
      return 0

    return rclient.scardAsync(this.getIPv6CategoryKey(category))
  }

  async addIPv6Addresses(category, addresses) {
    if(!this.isActivated(category))
      return []

    if(addresses.length === 0) {
      return []
    }

    let commands = [this.getIPv6CategoryKey(category)]

    commands.push.apply(commands, addresses)
    return rclient.saddAsync(commands)
  }

  async flushIPv6Addresses(category) {
    if(!this.isActivated(category))
      return [];

    return rclient.delAsync(this.getIPv6CategoryKey(category));
  }


  async getIncludedDomains(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getIncludeCategoryKey(category))
  }

  async addIncludedDomain(category, domain) {
    if(!this.isActivated(category))
      return

    return rclient.saddAsync(this.getIncludeCategoryKey(category), domain)
  }

  async removeIncludedDomain(category, domain) {
    if(!this.isActivated(category))
      return

    return rclient.sremAsync(this.getIncludeCategoryKey(category), domain)
  }

  async getExcludedDomains(category) {
    if(!this.isActivated(category))
      return []

    return rclient.smembersAsync(this.getExcludeCategoryKey(category))
  }

  async addExcludedDomain(category, domain) {
    if(!this.isActivated(category))
      return

    return rclient.saddAsync(this.getExcludeCategoryKey(category), domain)
  }

  async removeExcludedDomain(category, domain) {
    if(!this.isActivated(category))
      return

    return rclient.sremAsync(this.getExcludeCategoryKey(category), domain)
  }

  async includeDomainExists(category, domain) {
    if(!this.isActivated(category))
      return false

    return rclient.sismemberAsync(this.getIncludeCategoryKey(category), domain)
  }

  async excludeDomainExists(category, domain) {
    if(!this.isActivated(category))
      return false

    return rclient.sismemberAsync(this.getExcludeCategoryKey(category), domain)
  }

  async getDomainsWithExpireTime(category) {
    const key = this.getCategoryKey(category)

    const domainAndScores = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'withscores')
    const results = []

    for(let i = 0; i < domainAndScores.length; i++) {
      if(i % 2 === 1) {
        const domain = domainAndScores[i-1]
        const score = Number(domainAndScores[i])
        const expireDate = score + EXPIRE_TIME

        results.push({domain: domain, expire: expireDate})
      }
    }

    return results
  }

  async updateDomain(category, domain, isPattern) {

    if(!category || !domain) {
      return;
    }
    
    if(!this.isActivated(category)) {
      return
    }

    const now = Math.floor(new Date() / 1000)
    const key = this.getCategoryKey(category)

    let d = domain
    if(isPattern) {
      d = `*.${domain}`
    }

    const included = await this.includeDomainExists(category, d);

    if(!included) {
      const excluded = await this.excludeDomainExists(category, d);

      if(excluded) {
        return;
      }
    }

    log.debug(`Found a ${category} domain: ${d}`)

    await rclient.zaddAsync(key, now, d) // use current time as score for zset, it will be used to know when it should be expired out
    await this.updateIPSetByDomain(category, d, {})
  }

  getMapping(category) {
    return `cuip:${category}`
  }
  
  async updateDomainIPMapping(category, domain) {
    const domainBlock = require('./DomainBlock.js')()
    domainBlock.externalMapping = this.getMapping(category)
    
    // resolve this domain and add resolved ip addresses to the given mapping pool
    // e.g. cuip:games
    // the ip addresses in this pool will dynamically added and cleaned up periodically
    domainBlock.syncDomainIPMapping(domain, {
      exactMatch: true
    })
  }

  getIPSetName(category) {
    return `c_category_${category}`
  }
  
  getIPSetNameForIPV6(category) {
    return `c_category6_${category}`
  }

  getTempIPSetName(category) {
    return `c_tmp_category_${category}`
  }

  getTempIPSetNameForIPV6(category) {
    return `c_tmp_category6_${category}`
  }
  
  async updateIPSet(category, options) {
    const mapping = this.getMapping(category)
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)
    
    let cmd4 = `redis-cli smembers ${mapping} | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
    let cmd6 = `redis-cli smembers ${mapping} | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
    return (async () => {
      await exec(cmd4)
      await exec(cmd6)
    })()
  }
  
  getDomainMapping(domain) {
    return `rdns:domain:${domain}`
  }

  async getDomainMappingsByDomainPattern(domainPattern) {
    const keys = await rclient.keysAsync(`rdns:domain:${domainPattern}`)
    keys.push(this.getDomainMapping(domainPattern.substring(2)))
    return keys
  }

  getSummedDomainMapping(domain) {
    let d = domain
    if(d.startsWith("*.")) {
      d = d.substring(2)
    }

    return `srdns:pattern:${d}`
  }

  async updateIPv4Set(category, options) {
    const key = this.getIPv4CategoryKey(category)

    let ipsetName = this.getIPSetName(category)

    if(options && options.useTemp) {
      ipsetName = this.getTempIPSetName(category)
    }

    const hasAny = await rclient.scardAsync(key)

    if(hasAny > 0) {
      let cmd4 = `redis-cli smembers ${key} | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      await exec(cmd4).catch((err) => {
        log.error(`Failed to update ipset by category ${category} with ipv4 addresses, err: ${err}`)
      })
    }
  }

  async updateIPv6Set(category, options) {
    const key = this.getIPv6CategoryKey(category)

    let ipsetName = this.getIPSetNameForIPV6(category)

    if(options && options.useTemp) {
      ipsetName = this.getTempIPSetNameForIPV6(category)
    }

    const hasAny = await rclient.scardAsync(key)

    if(hasAny > 0) {
      let cmd4 = `redis-cli smembers ${key} | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      await exec(cmd4).catch((err) => {
        log.error(`Failed to update ipset by category ${category} with ipv6 addresses, err: ${err}`)
      })
    }
  }

  async updateIPSetByDomain(category, domain, options) {
    log.debug(`About to update category ${category} with domain ${domain}, options: ${JSON.stringify(options)}`)

    const mapping = this.getDomainMapping(domain)
    let ipsetName = this.getIPSetName(category)
    let ipset6Name = this.getIPSetNameForIPV6(category)

    if(options && options.useTemp) {
      ipsetName = this.getTempIPSetName(category)
      ipset6Name = this.getTempIPSetNameForIPV6(category)
    }

    if(domain.startsWith("*.")) {
      return this.updateIPSetByDomainPattern(category, domain, options)
    }

    const hasAny = await rclient.zcountAsync(mapping, '-inf', '+inf')

    if(hasAny) {
      let cmd4 = `redis-cli zrange ${mapping} 0 -1 | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      let cmd6 = `redis-cli zrange ${mapping} 0 -1 | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
      await exec(cmd4).catch((err) => {
        log.error(`Failed to update ipset by category ${category} domain ${domain}, err: ${err}`)
      })
      await exec(cmd6).catch((err) => {
        log.error(`Failed to update ipset6 by category ${category} domain ${domain}, err: ${err}`)
      })
    }

  }

  async updateIPSetByDomainPattern(category, domain, options) {
    if(!domain.startsWith("*.")) {
      return
    }

    log.debug(`About to update category ${category} with domain pattern ${domain}, options: ${JSON.stringify(options)}`)

    const mappings = await this.getDomainMappingsByDomainPattern(domain)

    if(mappings.length > 0) {
      const smappings = this.getSummedDomainMapping(domain)
      let array = [smappings, mappings.length]

      array.push.apply(array, mappings)

      await rclient.zunionstoreAsync(array)

      const exists = await rclient.typeAsync(smappings);
      if(exists === "none") {
        return; // if smapping doesn't exist, meaning no ip found for this domain, sometimes true for pre-provided domain list
      }

      await rclient.expireAsync(smappings, 600) // auto expire in 60 seconds

      let ipsetName = this.getIPSetName(category)
      let ipset6Name = this.getIPSetNameForIPV6(category)

      if(options && options.useTemp) {
        ipsetName = this.getTempIPSetName(category)
        ipset6Name = this.getTempIPSetNameForIPV6(category)
      }

      let cmd4 = `redis-cli zrange ${smappings} 0 -1 | egrep -v ".*:.*" | sed 's=^=add ${ipsetName} = ' | sudo ipset restore -!`
      let cmd6 = `redis-cli zrange ${smappings} 0 -1 | egrep ".*:.*" | sed 's=^=add ${ipset6Name} = ' | sudo ipset restore -!`
      return (async () => {
        await exec(cmd4)
        await exec(cmd6)
      })().catch((err) => {
        log.error(`Failed to update ipset by category ${category} domain pattern ${domain}, err: ${err}`)
      })
    }
  }

  async recycleIPSet(category, options) {
    const domains = await this.getDomains(category)
    const includedDomains = await this.getIncludedDomains(category);
    const defaultDomains = await this.getDefaultDomains(category);
    const excludeDomains = await this.getExcludedDomains(category);

    const ipv4AddressCount = await this.getIPv4AddressesCount(category);
    const ipv6AddressCount = await this.getIPv6AddressesCount(category);

    if(ipv4AddressCount > 0) {
      await this.updateIPv4Set(category, {useTemp: true})
    }

    if(ipv6AddressCount > 0) {
      await this.updateIPv6Set(category, {useTemp: true})
    }

//    let dd = _.union(domains, includedDomains)
    let dd = _.union(domains, defaultDomains)
    dd = _.difference(dd, excludeDomains)
    dd = _.union(dd, includedDomains)

    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)
    const tmpIPSetName = this.getTempIPSetName(category)
    const tmpIPSet6Name = this.getTempIPSetNameForIPV6(category)

    for (let i = 0; i < dd.length; i++) {
      const domain = dd[i]

      let domainSuffix = domain
      if(domainSuffix.startsWith("*.")) {
        domainSuffix = domainSuffix.substring(2);
      }
      
      const existing = await dnsTool.reverseDNSKeyExists(domainSuffix)
      if(!existing) { // a new domain
        log.info(`Found a new domain with new rdns: ${domainSuffix}`)
        await domainBlock.resolveDomain(domainSuffix)
      }
      
      await this.updateIPSetByDomain(category, domain, {useTemp: true}).catch((err) => {
        log.error(`Failed to update ipset for domain ${domain}, err: ${err}`)
      })
    }

    // swap temp ipset with ipset
    const swapCmd = `sudo ipset swap ${ipsetName} ${tmpIPSetName}`
    const swapCmd6 = `sudo ipset swap ${ipset6Name} ${tmpIPSet6Name}`

    await exec(swapCmd).catch((err) => {
      log.error(`Failed to swap ipsets for category ${category}, err: ${err}`)
    })

    await exec(swapCmd6).catch((err) => {
      log.error(`Failed to swap ipsets6 for category ${category}, err: ${err}`)
    })

    const flushCmd = `sudo ipset flush ${tmpIPSetName}`
    const flushCmd6 = `sudo ipset flush ${tmpIPSet6Name}`

    await exec(flushCmd).catch((err) => {
      log.error(`Failed to flush temp ipsets for category ${category}, err: ${err}`)
    })

    await exec(flushCmd6).catch((err) => {
      log.error(`Failed to flush temp ipsets6 for category ${category}, err: ${err}`)
    })

    log.info(`Successfully recycled ipset for category ${category}`)
  }

  async deleteCategoryRecord(category) {
    const key = this.getCategoryKey(category)
    return rclient.delAsync(key)
  }

  getCategories() {
    return Object.keys(this.activeCategories)
  }

  activateCategory(category) {
    this.activeCategories[category] = 1
  }

  async disactivateCategory(category) {
    delete this.activeCategories[category]
    await this.deleteCategoryRecord(category)
  }

  isActivated(category) {
    // always return true for now
    return this.activeCategories[category] !== undefined
  }

  async refreshCategoryRecord(category) {
    const key = this.getCategoryKey(category)
    const date = Math.floor(new Date() / 1000) - EXPIRE_TIME

    return rclient.zremrangebyscoreAsync(key, '-inf', date)
  }

  async refreshAllCategoryRecords() {
    const categories = this.getCategories()

    for (let i = 0; i < categories.length ; i++) {
      const category = categories[i]

      await this.refreshCategoryRecord(category).catch((err) => {
        log.error(`Failed to refresh category ${category}, err: ${err}`)
      }) // refresh domain list for each category

      await this.recycleIPSet(category).catch((err) => {
        log.error(`Failed to recycle ipset for category ${category}, err: ${err}`)
      }) // sync refreshed domain list to ipset
    }

  }

  getHttpPort(category) {
    if(category === 'default_c') {
      return blackHoleHttpPort;
    } else {
      return redirectHttpPort;
    }
  }

  getHttpsPort(category) {
    if(category === 'default_c') {
      return blackHoleHttpsPort;
    } else {
      return redirectHttpsPort;
    }
  }

  async iptablesRedirectCategory(category) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    const cmdRedirectHTTPRule = `sudo iptables -w -t nat -C PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)} || sudo iptables -t nat -I PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`
    const cmdRedirectHTTPSRule = `sudo iptables -w -t nat -C PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)} || sudo iptables -t nat -I PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`
    const cmdRedirectHTTPRule6 = `sudo ip6tables -w -t nat -C PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)} || sudo ip6tables -t nat -I PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`
    const cmdRedirectHTTPSRule6 = `sudo ip6tables -w -t nat -C PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)} || sudo ip6tables -t nat -I PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`

    await exec(cmdRedirectHTTPRule)
    await exec(cmdRedirectHTTPSRule)
    await exec(cmdRedirectHTTPRule6)
    await exec(cmdRedirectHTTPSRule6)
  }

  async iptablesUnredirectCategory(category) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    const cmdRedirectHTTPRule = `sudo iptables -w -t nat -D PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`
    const cmdRedirectHTTPSRule = `sudo iptables -w -t nat -D PREROUTING -p tcp -m set --match-set ${ipsetName} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`
    const cmdRedirectHTTPRule6 = `sudo ip6tables -w -t nat -D PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 80 -j REDIRECT --to-ports ${this.getHttpPort(category)}`
    const cmdRedirectHTTPSRule6 = `sudo ip6tables -w -t nat -D PREROUTING -p tcp -m set --match-set ${ipset6Name} dst --destination-port 443 -j REDIRECT --to-ports ${this.getHttpsPort(category)}`

    await exec(cmdRedirectHTTPRule)
    await exec(cmdRedirectHTTPSRule)
    await exec(cmdRedirectHTTPRule6)
    await exec(cmdRedirectHTTPSRule6)
  }
  
  async iptablesBlockCategory(category) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    const cmdCreateOutgoingRule = `sudo iptables -w -C FW_BLOCK -p all -m set --match-set ${ipsetName} dst -j DROP || sudo iptables -w -I FW_BLOCK -p all -m set --match-set ${ipsetName} dst -j DROP`
    const cmdCreateIncomingRule = `sudo iptables -w -C FW_BLOCK -p all -m set --match-set ${ipsetName} src -j DROP || sudo iptables -w -I FW_BLOCK -p all -m set --match-set ${ipsetName} src -j DROP`
    const cmdCreateOutgoingTCPRule = `sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set ${ipsetName} dst -j REJECT || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set ${ipsetName} dst -j REJECT`
    const cmdCreateIncomingTCPRule = `sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set ${ipsetName} src -j REJECT || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set ${ipsetName} src -j REJECT`
    const cmdCreateOutgoingRule6 = `sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set ${ipset6Name} dst -j DROP || sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set ${ipset6Name} dst -j DROP`
    const cmdCreateIncomingRule6 = `sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set ${ipset6Name} src -j DROP || sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set ${ipset6Name} src -j DROP`
    const cmdCreateOutgoingTCPRule6 = `sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set ${ipset6Name} dst -j REJECT || sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set ${ipset6Name} dst -j REJECT`
    const cmdCreateIncomingTCPRule6 = `sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set ${ipset6Name} src -j REJECT || sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set ${ipset6Name} src -j REJECT`

    await exec(cmdCreateOutgoingRule)
    await exec(cmdCreateIncomingRule)
    await exec(cmdCreateOutgoingTCPRule)
    await exec(cmdCreateIncomingTCPRule)
    await exec(cmdCreateOutgoingRule6)
    await exec(cmdCreateIncomingRule6)
    await exec(cmdCreateOutgoingTCPRule6)
    await exec(cmdCreateIncomingTCPRule6)
  }

  async iptablesUnblockCategory(category) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    const cmdDeleteOutgoingRule = `sudo iptables -w -D FW_BLOCK -p all -m set --match-set ${ipsetName} dst -j DROP`
    const cmdDeleteIncomingRule = `sudo iptables -w -D FW_BLOCK -p all -m set --match-set ${ipsetName} src -j DROP`
    const cmdDeleteOutgoingTCPRule = `sudo iptables -w -D FW_BLOCK -p tcp -m set --match-set ${ipsetName} dst -j REJECT`
    const cmdDeleteIncomingTCPRule = `sudo iptables -w -D FW_BLOCK -p tcp -m set --match-set ${ipsetName} src -j REJECT`
    const cmdDeleteOutgoingRule6 = `sudo ip6tables -w -D FW_BLOCK -p all -m set --match-set ${ipset6Name} dst -j DROP`
    const cmdDeleteIncomingRule6 = `sudo ip6tables -w -D FW_BLOCK -p all -m set --match-set ${ipset6Name} src -j DROP`
    const cmdDeleteOutgoingTCPRule6 = `sudo ip6tables -w -D FW_BLOCK -p tcp -m set --match-set ${ipset6Name} dst -j REJECT`
    const cmdDeleteIncomingTCPRule6 = `sudo ip6tables -w -D FW_BLOCK -p tcp -m set --match-set ${ipset6Name} src -j REJECT`

    await exec(cmdDeleteOutgoingRule)
    await exec(cmdDeleteIncomingRule)
    await exec(cmdDeleteOutgoingTCPRule)
    await exec(cmdDeleteIncomingTCPRule)
    await exec(cmdDeleteOutgoingRule6)
    await exec(cmdDeleteIncomingRule6)
    await exec(cmdDeleteOutgoingTCPRule6)
    await exec(cmdDeleteIncomingTCPRule6)
  }

  wrapIptables(rule) {        
    let command = " -I ";
    let checkRule = null;

    if(rule.indexOf(command) > -1) {
      checkRule = rule.replace(command, " -C ");
    }      

    command = " -A ";
    if(rule.indexOf(command) > -1) {
      checkRule = rule.replace(command, " -C ");
    }

    command = " -D ";
    if(rule.indexOf(command) > -1) {
      checkRule = rule.replace(command, " -C ");
      return `bash -c '${checkRule} &>/dev/null && ${rule}'`;
    }

    if(checkRule) {
      return `bash -c '${checkRule} &>/dev/null || ${rule}'`;
    } else {
      return rule;  
    }    
  }

  async iptablesBlockCategoryPerDeviceNew(category, macSet) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    // -A PREROUTING -p tcp -m set --match-set c_category_av dst -m tcp -j REDIRECT --to-ports 8888
    // -A FW_BLOCK -p tcp -m set --match-set c_bm_150_set dst -m set --match-set c_bd_150_set src -j REJECT --reject-with icmp-port-unreachable

    const cmdCreateOutgoingTCPRule = this.wrapIptables(`sudo iptables -w -t nat -I FW_NAT_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j REDIRECT --to-ports 8888`);
    const cmdCreateOutgoingUDPRule = this.wrapIptables(`sudo iptables -w -t nat -I FW_NAT_BLOCK -p udp -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j REDIRECT --to-ports 8888`);

    const cmdCreateOutgoingTCPRule6 = this.wrapIptables(`sudo ip6tables -w -t nat -I FW_NAT_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j REDIRECT --to-ports 8888`);
    const cmdCreateOutgoingUDPRule6 = this.wrapIptables(`sudo ip6tables -w -t nat -I FW_NAT_BLOCK -p udp -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j REDIRECT --to-ports 8888`);

    await exec(cmdCreateOutgoingTCPRule);
    await exec(cmdCreateOutgoingUDPRule);
    await exec(cmdCreateOutgoingTCPRule6);
    await exec(cmdCreateOutgoingUDPRule6);
  }

  // This function requires the mac ipset has already been created
  async iptablesBlockCategoryPerDevice(category, macSet) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

      // -A PREROUTING -p tcp -m set --match-set c_category_av dst -m tcp -j REDIRECT --to-ports 8888
    // -A FW_BLOCK -p tcp -m set --match-set c_bm_150_set dst -m set --match-set c_bd_150_set src -j REJECT --reject-with icmp-port-unreachable



    const cmdCreateOutgoingRule = `sudo iptables -w -C FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j DROP || sudo iptables -w -I FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j DROP`
    const cmdCreateIncomingRule = `sudo iptables -w -C FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${ipsetName} src -j DROP || sudo iptables -w -I FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${ipsetName} src -j DROP`
    const cmdCreateOutgoingTCPRule = `sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j REJECT || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j REJECT`
    const cmdCreateIncomingTCPRule = `sudo iptables -w -C FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${ipsetName} src -j REJECT || sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${ipsetName} src -j REJECT`
    const cmdCreateOutgoingRule6 = `sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j DROP || sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j DROP`
    const cmdCreateIncomingRule6 = `sudo ip6tables -w -C FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${ipset6Name} src -j DROP || sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${ipset6Name} src -j DROP`
    const cmdCreateOutgoingTCPRule6 = `sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j REJECT || sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j REJECT`
    const cmdCreateIncomingTCPRule6 = `sudo ip6tables -w -C FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${ipset6Name} src -j REJECT || sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${ipset6Name} src -j REJECT`

    await exec(cmdCreateOutgoingRule)
    await exec(cmdCreateIncomingRule)
    await exec(cmdCreateOutgoingTCPRule)
    await exec(cmdCreateIncomingTCPRule)
    await exec(cmdCreateOutgoingRule6)
    await exec(cmdCreateIncomingRule6)
    await exec(cmdCreateOutgoingTCPRule6)
    await exec(cmdCreateIncomingTCPRule6)
  }

  async iptablesUnblockCategoryPerDeviceNew(category, macSet) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    const cmdDeleteOutgoingTCPRule = this.wrapIptables(`sudo iptables -w -t nat -D FW_NAT_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j REDIRECT --to-ports 8888`);
    const cmdDeleteOutgoingUDPRule = this.wrapIptables(`sudo iptables -w -t nat -D FW_NAT_BLOCK -p udp -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j REDIRECT --to-ports 8888`);

    const cmdDeleteOutgoingTCPRule6 = this.wrapIptables(`sudo ip6tables -w -t nat -D FW_NAT_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j REDIRECT --to-ports 8888`);
    const cmdDeleteOutgoingUDPRule6 = this.wrapIptables(`sudo ip6tables -w -t nat -D FW_NAT_BLOCK -p udp -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j REDIRECT --to-ports 8888`);

    await exec(cmdDeleteOutgoingTCPRule);
    await exec(cmdDeleteOutgoingUDPRule);
    await exec(cmdDeleteOutgoingTCPRule6);
    await exec(cmdDeleteOutgoingUDPRule6);    
  }

  async iptablesUnblockCategoryPerDevice(category, macSet) {
    const ipsetName = this.getIPSetName(category)
    const ipset6Name = this.getIPSetNameForIPV6(category)

    const cmdDeleteOutgoingRule6 = `sudo ip6tables -w -D FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j DROP`
    const cmdDeleteIncomingRule6 = `sudo ip6tables -w -D FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${ipset6Name} src -j DROP`
    const cmdDeleteOutgoingTCPRule6 = `sudo ip6tables -w -D FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipset6Name} dst -j REJECT`
    const cmdDeleteIncomingTCPRule6 = `sudo ip6tables -w -D FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${ipset6Name} src -j REJECT`
    const cmdDeleteOutgoingRule = `sudo iptables -w -D FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j DROP`
    const cmdDeleteIncomingRule = `sudo iptables -w -D FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${ipsetName} src -j DROP`
    const cmdDeleteOutgoingTCPRule = `sudo iptables -w -D FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${ipsetName} dst -j REJECT`
    const cmdDeleteIncomingTCPRule = `sudo iptables -w -D FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${ipsetName} src -j REJECT`

    await (exec(cmdDeleteOutgoingRule6))
    await (exec(cmdDeleteIncomingRule6))
    await (exec(cmdDeleteOutgoingTCPRule6))
    await (exec(cmdDeleteIncomingTCPRule6))
    await (exec(cmdDeleteOutgoingRule))
    await (exec(cmdDeleteIncomingRule))
    await (exec(cmdDeleteOutgoingTCPRule))
    await (exec(cmdDeleteIncomingTCPRule))
  }

}

module.exports = CategoryUpdater
