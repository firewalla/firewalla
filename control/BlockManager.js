/*    Copyright 2020 Firewalla Inc
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
const rclient = require('../util/redis_manager.js').getRedisClient();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Block = require('./Block.js');
const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()
const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();
const _ = require('lodash');
const fc = require('../net2/config.js');
const featureName = 'smart_block';
let instance = null;
const expiring = 24 * 60 * 60 * 3;  // three days

class BlockManager {
    constructor() {
        if (instance == null) {
            instance = this;
            const refreshInterval = 15 * 60; // 15 mins
            sem.once('IPTABLES_READY', async () => {
                if (fc.isFeatureOn(featureName)) {
                    this.scheduleId = setInterval(() => {
                        this.scheduleRefreshBlockLevel();
                    }, refreshInterval * 1000)
                }
                fc.onFeature(featureName, async (feature, status) => {
                    if (feature !== featureName) {
                        return
                    }
                    await this.reenforcePolicies();
                    if (status) {
                        this.scheduleId = setInterval(() => {
                            this.scheduleRefreshBlockLevel();
                        }, refreshInterval * 1000)
                    } else {
                        clearInterval(this.scheduleId);
                    }
                })
            })
        }
        return instance
    }
    async reenforcePolicies() {
        const PolicyManager2 = require('../alarm/PolicyManager2.js');
        const pm2 = new PolicyManager2();
        log.info('smart block enabled, re-enforce policies');
        const policies = await pm2.loadActivePoliciesAsync();
        policies.map((policy) => {
            pm2.tryPolicyEnforcement(policy, 'reenforce', policy);
        })
    }
    ipBlockInfoKey(ip) {
        return `ip:block:info:${ip}`
    }
    domainBlockInfoKey(domain) {
        return `domain:block:info:${domain}`
    }
    categoryDomainBlockInfoKey(domain) {
        return `category:block:info:${domain}`
    }
    getCategoryIpMapping(category) {
        return `rdns:category:${category}`
    }
    async getPureCategoryIps(category, categoryIps, originDomain) {
        if (!fc.isFeatureOn(featureName)) {
            return categoryIps;
        }
        const pureCategoryIps = [], mixupCategoryIps = [], mixupIpInfos = [];
        try {
            for (const categoryIp of categoryIps) {
                let pure = true;
                let mixupDomain;
                let mixupCategory;
                const domains = await dnsTool.getAllDns(categoryIp);
                for (const domain of domains) {
                    mixupDomain = domain;
                    const ips = await dnsTool.getIPsByDomain(domain);
                    for (const ip of ips) {
                        const intel = (await intelTool.getIntel(ip)) || {};
                        mixupCategory = intel.category;
                        pure = pure && intel.category == category;
                        if (!pure) break;
                    }
                    if (!pure) break;
                }
                if (pure) {
                    pureCategoryIps.push(categoryIp)
                } else {
                    mixupCategoryIps.push(categoryIp);
                    mixupIpInfos.push({
                        ip: categoryIp,
                        mixupDomain: mixupDomain,
                        mixupCategory: mixupCategory
                    })
                }
            }
            const categoryIpMappingKey = this.getCategoryIpMapping(category);
            mixupCategoryIps.length > 0 && await rclient.sremAsync(categoryIpMappingKey, mixupCategoryIps);
            pureCategoryIps.length > 0 && await rclient.saddAsync(categoryIpMappingKey, pureCategoryIps);
            const categoryDomainBlockInfoKey = this.categoryDomainBlockInfoKey(originDomain);
            await rclient.setAsync(categoryDomainBlockInfoKey, JSON.stringify({
                pureCategoryIps: pureCategoryIps,
                mixupIpInfos: mixupIpInfos
            }))
            rclient.expireat(categoryDomainBlockInfoKey, parseInt((+new Date) / 1000) + expiring);
        } catch (e) {
            log.info("get pure category ips failed", e)
        }
        return pureCategoryIps;
    }
    async applyNewDomain(ip, domain) {
        await this.updateIpBlockInfo(ip, domain, 'newDomain')
    }
    async scheduleRefreshBlockLevel() {
        const ipBlockKeys = await rclient.keysAsync("ip:block:info:*");
        log.info('schedule refresh block level for these ips:', ipBlockKeys)
        ipBlockKeys.map(async (key) => {
            try {
                let ipBlockInfo = JSON.parse(await rclient.getAsync(key));
                if (!ipBlockInfo) {
                    await rclient.delAsync(key);
                    return;
                }
                const { targetDomains, ip, blockLevel, blockSet } = ipBlockInfo;
                const allDomains = await dnsTool.getAllDns(ip);
                const sharedDomains = _.differenceWith(allDomains, targetDomains, (a, b) => {
                    return this.domainCovered(b, a);
                });
                if (sharedDomains.length == 0 && blockLevel == 'domain') {
                    Block.block(ip, blockSet)
                }
                if (sharedDomains.length > 0 && blockLevel == 'ip') {
                    Block.unblock(ip, blockSet);
                }
                ipBlockInfo.ts = new Date() / 1000;
                ipBlockInfo.sharedDomains = sharedDomains;
                ipBlockInfo.allDomains = allDomains;
                await rclient.setAsync(key, JSON.stringify(ipBlockInfo));
            } catch (err) {
                log.warn('parse error', err);
            }
        })
    }
    async updateIpBlockInfo(ip, domain, action, blockSet = 'block_domain_set') {
        let ipBlockInfo = {
            blockSet: blockSet,
            ip: ip,
            targetDomains: [],
            sharedDomains: [],
            allDomains: [],
            ts: new Date() / 1000
        }
        let exist;
        if (!fc.isFeatureOn(featureName)) {
            ipBlockInfo.blockLevel = 'ip';
        } else {
            const key = this.ipBlockInfoKey(ip);
            exist = (await rclient.existsAsync(key) == 1);
            if (exist) {
                ipBlockInfo = JSON.parse(await rclient.getAsync(key));
            }
            switch (action) {
                case 'block': {
                    // if the ip shared with other domain, should not apply ip level block
                    // if a.com and b.com share ip and one of them block, it should be domain level
                    // if both block, should update to ip level
                    !ipBlockInfo.targetDomains.includes(domain) && ipBlockInfo.targetDomains.push(domain);
                    const allDomains = await dnsTool.getAllDns(ip);
                    const sharedDomains = _.differenceWith(allDomains, ipBlockInfo.targetDomains, (a, b) => {
                        return this.domainCovered(b, a);
                    });
                    sharedDomains.length > 0 && log.info(`${ipBlockInfo.targetDomains.join(',')} ip ${ip} shared with domains ${sharedDomains.join(',')}`)
                    if (sharedDomains.length == 0) {
                        ipBlockInfo.blockLevel = 'ip';
                    } else {
                        ipBlockInfo.blockLevel = 'domain';
                    }
                    ipBlockInfo.sharedDomains = sharedDomains;
                    ipBlockInfo.allDomains = allDomains;
                    ipBlockInfo.ts = new Date() / 1000;
                    await rclient.setAsync(key, JSON.stringify(ipBlockInfo));
                    break;
                }
                case 'unblock': {
                    !ipBlockInfo.sharedDomains.includes(domain) && ipBlockInfo.sharedDomains.push(domain);
                    ipBlockInfo.targetDomains = _.filter(ipBlockInfo.targetDomains, (a) => {
                        return a != domain;
                    })
                    if (ipBlockInfo.targetDomains.length == 0) {
                        await rclient.delAsync(key);
                    } else {
                        ipBlockInfo.ts = new Date() / 1000;
                        ipBlockInfo.blockLevel = 'domain';
                        await rclient.setAsync(key, JSON.stringify(ipBlockInfo));
                    }
                    break;
                }
                case 'newDomain': {
                    if (exist) {
                        // it is old ip and new domain
                        const { blockSet, targetDomains } = ipBlockInfo;
                        const alreayExistInTargetDomains = _.find(targetDomains, (targetDomain) => {
                            return this.domainCovered(targetDomain, domain);
                        })
                        if (!alreayExistInTargetDomains) {
                            if (ipBlockInfo.blockLevel == 'ip') {
                                log.info('ip block level change when new doamin comming', ip, domain)
                                ipBlockInfo.blockLevel = 'domain';
                                Block.unblock(ip, blockSet);
                            }
                            ipBlockInfo.sharedDomains.push(domain);
                            ipBlockInfo.allDomains = await dnsTool.getAllDns(ip);
                            ipBlockInfo.ts = new Date() / 1000;
                            await rclient.setAsync(key, JSON.stringify(ipBlockInfo));
                        }
                    }
                    break;
                }
            }
        }
        if (action == 'block' || action == 'unblock' || (action == 'newDomain' && exist)) {
            await this.updateDomainBlockInfo(domain, ipBlockInfo);
        }
        return ipBlockInfo;
    }
    async updateDomainBlockInfo(domain, ipBlockInfo) {
        const key = this.domainBlockInfoKey(domain);
        let domainBlockInfo = await rclient.getAsync(key);
        try {
            domainBlockInfo = JSON.parse(domainBlockInfo) || {};
        } catch (err) {
            domainBlockInfo = {};
        }
        domainBlockInfo[ipBlockInfo.ip] = ipBlockInfo;
        await rclient.setAsync(key, JSON.stringify(domainBlockInfo));
        rclient.expireat(key, parseInt((+new Date) / 1000) + expiring);
    }
    domainCovered(blockDomain, otherDomain) {
        // a.b.com covred x.a.b.com
        if (!otherDomain) return true;
        if (blockDomain.startsWith('*.')) blockDomain = blockDomain.substring(2)
        if (otherDomain.startsWith('*.')) otherDomain = otherDomain.substring(2)
        const h1Sections = blockDomain.split('.').reverse();
        const h2Sections = otherDomain.split('.').reverse();
        for (let i = 0; i < h1Sections.length; i++) {
            if (h1Sections[i] !== h2Sections[i])
                return false;
        }
        return true;
    }
}

module.exports = BlockManager
