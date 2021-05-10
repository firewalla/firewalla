/*    Copyright 2020 Firewalla Inc.
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


'use strict'

const log = require('../../net2/logger.js')(__filename)
const fc = require('../../net2/config.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();
const tracking = require('./tracking.js');
const accounting = require('./accounting.js');
const rclient = require('../../util/redis_manager.js').getRedisClient()
const { generateStrictDateTs } = require('../../util/util.js');
let instance = null;
const runningCheckJobs = {};
const INTF_PREFIX = "intf:";
const TAG_PREFIX = "tag:";
const MAC_PREFIX = "mac:"
const _ = require('lodash');
const f = require('../../net2/Firewalla.js');

/*
    policy:create
    {
        action: "screentime"
        target: av | customize category name | wechat 
        type: app | category | mac
        threshold: 120 => mins
        offset: 2*60*60 => 2 hours, 02:00 - next day 02:00, default: 0
        scope: ['mac:XX:XX:XX:XX','tag:uid','intf:uuid']
        applyRules: [
            {
                action: block
                target?: domainName/categoryName/ or empty when type=='mac'
                type: dns/category/mac  dns==> this is for app block
                app.name?: xxx
                app.uid?: xxx
            }
        ]
    }
*/

class ScreenTime {
    constructor() {
        if (instance == null) {
            instance = this;
        }
        return instance;
    }
    async registerPolicy(policy) {
        const pid = policy.pid
        if (runningCheckJobs[pid]) { // already have a running job for this pid
            return;
        }
        log.info(`Registering policy ${policy.pid} for screentime check`)
        const timer = setInterval(() => {
            this.checkAndRunOnce(policy);
        }, 5 * 60 * 1000) // check every 5 mins
        runningCheckJobs[pid] = { policy, timer }; // register job
        this.checkAndRunOnce(policy);
    }

    async deregisterPolicy(policy) {
        const pid = policy.pid
        if (pid == undefined) {
            return;
        }
        log.info(`deregistering policy ${pid}`)
        const timer = runningCheckJobs[pid] && runningCheckJobs[pid].timer;
        timer && clearInterval(timer);
        delete runningCheckJobs[pid]
    }
    dependFeatureEnabled() {
        if (!platform.isAccountingSupported() || !fc.isFeatureOn("accounting") || !f.isDevelopmentVersion()) {
            log.info("Accounting feature is not supported or disabled.");
            return false;
        }
        return true;
    }
    async checkAndRunOnce(policy) {
        if (!this.dependFeatureEnabled()) return;
        if (!runningCheckJobs[policy.pid]) {
            log.warn(`screen time check job ${policy.pid} doesn't register`);
            return;
        }
        const timeFrame = this.generateTimeFrame(policy);
        if (policy.recent_reached_ts == timeFrame.begin) {
            log.info(`screen time limted alredy reached recently`);
            return;
        }
        const macs = await this.getPolicyRelatedMacs(policy);
        const count = await this.getMacsUsedTime(macs, policy, timeFrame);
        log.info(`Policy ${policy.pid} screen time: ${count}, macs: ${macs.join(',')} begin: ${timeFrame.begin} end: ${timeFrame.end}`, policy);
        const { threshold } = policy;
        if (Number(count) > Number(threshold)) {
            await this.createAlarm(policy, {
                timeFrame: timeFrame
            });
            await this.createRule(policy, timeFrame);
            policy.recent_reached_ts = timeFrame.begin;
            await rclient.hsetAsync('policy:' + policy.pid, 'recent_reached_ts', timeFrame.begin);
        } else {
            policy.recent_reached_ts = '';
        }
    }
    async createRule(policy, timeFrame) {
        const PM2 = require('../../alarm/PolicyManager2.js');
        const pm2 = new PM2();
        const policyPayloads = this.generatePolicyPayloads(policy, timeFrame);
        try {
            const result = await pm2.batchPolicy({
                "create": policyPayloads
            })
            const pids = (result.create || []).filter(rule => rule && rule.pid).map(rule => rule.pid);
            pids.length > 0 && log.info("Auto pause policy is created successfully, pids:", pids);
            return pids
        } catch (err) {
            log.error("Failed to create policy:", err);
        }
    }
    async createAlarm(policy, info) {
        const { timeFrame } = info;
        const Alarm = require('../../alarm/Alarm.js');
        const AM2 = require('../../alarm/AlarmManager2.js');
        const am2 = new AM2();
        const alarm = new Alarm.ScreenTimeAlarm(new Date() / 1000,
            'screetime',
            {
                "p.pid": policy.pid,
                "p.scope": policy.scope,
                "p.threshold": policy.threshold,
                "p.timeframe.begin": timeFrame.begin / 1000,
                "p.timeframe.end": timeFrame.end / 1000,
                "p.target": policy.target,
                "p.type": policy.type
            });
        am2.enqueueAlarm(alarm);
    }
    generatePolicyPayloads(policy, timeFrame) {
        const { applyRules, scope } = policy;
        if (!applyRules || applyRules.length == 0) return [];
        const policyPayloads = [];
        for (const rawRule of applyRules) {
            rawRule.activatedTime = timeFrame.now / 1000;
            rawRule.timestamp = timeFrame.now / 1000;
            rawRule.expire = timeFrame.expire;
            rawRule.autoDeleteWhenExpires = '1';
            rawRule.related_screen_time_pid = policy.pid;
            if (scope && scope.length > 0) {
                for (const ele of scope) {
                    const rawRuleCopy = JSON.parse(JSON.stringify(rawRule));
                    if (ele.includes(MAC_PREFIX)) {
                        const mac = ele.split(MAC_PREFIX)[1];
                        if (rawRuleCopy.type == 'mac') {
                            rawRuleCopy.target = mac;
                        } else {
                            rawRuleCopy.scope = [mac];
                        }
                    } else if (ele.includes(INTF_PREFIX) || ele.includes(TAG_PREFIX)) {
                        if (rawRuleCopy.type == 'mac') {
                            rawRuleCopy.target = 'TAG';
                        }
                        rawRuleCopy.tag = [ele];
                    }
                    policyPayloads.push(rawRuleCopy);
                }
            } else { // global level
                policyPayloads.push(rawRule);
            }
        }
        return policyPayloads;
    }
    generateTimeFrame(policy) {
        // calculate expire by offset(02:00 - next day 02:00) => 2*60*60 seconds
        // default time frame 00:00 - next day 00:00 default offset 0
        const offset = (policy.offset || 0) * 1000;
        const now = new Date();
        const { beginTs, endTs } = generateStrictDateTs(now);
        const begin = beginTs + offset;
        const end = endTs + offset;
        const expire = Math.ceil((end - now) / 1000);
        return {
            begin, end, expire, now
        }
    }
    async getPolicyRelatedMacs(policy) {
        const HostManager = require("../../net2/HostManager.js");
        const hostManager = new HostManager();
        const { scope } = policy;
        if (!scope) return hostManager.getActiveMACs();
        let allMacs = [];
        for (const ele of scope) {
            if (ele.includes(MAC_PREFIX)) {
                allMacs.push(ele.split(MAC_PREFIX)[1]);
            } else if (ele.includes(INTF_PREFIX)) {
                const uuid = ele.split(INTF_PREFIX)[1];
                allMacs = allMacs.concat(hostManager.getIntfMacs(uuid));
            } else if (ele.includes(TAG_PREFIX)) {
                const tagUid = ele.split(TAG_PREFIX)[1];
                allMacs = allMacs.concat(await hostManager.getTagMacs(tagUid));
            } else {
                allMacs = hostManager.getActiveMACs();
            }
        }
        return _.uniq(allMacs);
    }
    async getMacsUsedTime(macs, policy, timeFrame) {
        if (!macs || macs.length == 0) return 0;
        const { target, type } = policy;
        const { begin, end } = timeFrame;
        const blockInternet = !['app', 'category'].includes(type);
        let count = 0;
        for (const mac of macs) {
            try {
                // maybe get screentime/accounting from host directly if time frame always is 00:00 - next day 00:00
                if (blockInternet) {
                    await tracking.aggr(mac);
                    count += await tracking.getUsedTime(mac);
                } else {
                    count += await accounting.count(mac, target, begin, end);
                }
            } catch (e) { }
        }
        return count;
    }
}

module.exports = new ScreenTime();

