/*    Copyright 2020 Firewalla LLC
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
const { isSimilarHost } = require('../util/util');
const _ = require('lodash');
let instance = null

class BlockManager {
    constructor() {
        if (instance == null) {
            instance = this;
            const refreshInterval = 15 * 60; // 15 mins
            sem.once('IPTABLES_READY', async () => {
                sem.on('UPDATE_CATEGORY_DOMAIN', async (event) => {
                    if (event.category) {
                        await this.categoryUpdate(event.category);
                    }
                });
                setTimeout(() => {
                    this.scheduleRefreshBlockLevel();
                }, refreshInterval * 1000)
            })
        }
        return instance
    }
    ipBlockInfoKey(ip) {
        return `ip:block:info:${ip}`
    }
    async categoryUpdate() {
        // todo
        // const PM2 = require('../alarm/PolicyManager2.js');
        // const pm2 = new PM2();
        // const policies = await pm2.loadActivePoliciesAsync();
        // for (const policy of policies) {
        //     if (policy.type == "category" && policy.target == event.category && policy.dnsmasq_entry) {
        //         await pm2.tryPolicyEnforcement(policy, 'reenforce', policy)
        //     }
        // }
    }
    async applyNewDomain(ip, domain) {
        const key = this.ipBlockInfoKey(ip);
        const exist = (await rclient.existsAsync(key) == 1);
        if (exist) {
            let ipBlcokInfo = JSON.parse(await rclient.getAsync(key));
            const { blockSet, targetDomains } = ipBlcokInfo;
            const alreayExistInTargetDomains = _.find(targetDomains, (targetDomain) => {
                return isSimilarHost(targetDomain, domain);
            })
            if (ipBlcokInfo.block_level == 'ip' && !alreayExistInTargetDomains) {
                log.info('ip block level change when new doamin comming', ip, domain)
                ipBlcokInfo.sharedDomains = [domain];
                ipBlcokInfo.block_level = 'domain';
                ipBlcokInfo.ts = new Date() / 1000;
                Block.unblock(ip, blockSet);
                await rclient.setAsync(key, JSON.stringify(ipBlcokInfo));
            }
        }
    }
    async scheduleRefreshBlockLevel() {
        const ipBlockKeys = await rclient.keysAsync("ip:block:info:*");
        log.info('schedule refresh block level for these ips:', ipBlockKeys)
        ipBlockKeys.map(async (key) => {
            let ipBlcokInfo = JSON.parse(await rclient.getAsync(key));
            const { targetDomains, ip, block_level, blockSet } = ipBlcokInfo;
            const allDomains = await dnsTool.getAllDns(ip);
            const sharedDomains = _.differenceWith(targetDomains, allDomains, (a, b) => {
                return isSimilarHost(a, b);
            });
            if (sharedDomains.length == 0 && block_level == 'domain') {
                Block.block(ip, blockSet)
            }
            if (sharedDomains.length > 0 && block_level == 'ip') {
                Block.unblock(ip, blockSet);
            }
            ipBlcokInfo.ts = new Date() / 1000;
            ipBlcokInfo.sharedDomains = sharedDomains;
            await rclient.setAsync(key, JSON.stringify(ipBlcokInfo));
        })
    }
}

module.exports = BlockManager
