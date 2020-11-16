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
'use strict';
const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;
const rclient = require('../util/redis_manager.js').getRedisClient();
const PolicyManager2 = require('../alarm/PolicyManager2.js')
const Policy = require('../alarm/Policy.js');
const pm2 = new PolicyManager2()
const extensionManager = require('./ExtensionManager.js')
const sem = require('../sensor/SensorEventManager.js').getInstance();
class PolicySensor extends Sensor {
    constructor() {
        super();
        this.timerMap = {};
    }
    run() {
    }
    oneTimePausePolicyKey(pid) {
        return `policy:onetime:pause:${pid}`;
    }

    apiRun() {
        extensionManager.onSet("policy:onetime:pause", async (msg, data) => {
            if (!data || !data.pid || !data.expire || !data.activatedTime)
                throw new Error("invalid policy data");
            const policy = new Policy({
                pid: data.pid,
                expire: data.expire,
                activatedTime: data.activatedTime,
                type: 'policy:onetime:pause'
            })
            if (policy.willExpireSoon()) {
                throw new Error("pause policy will expire soon");
            }
            try {
                await rclient.hmsetAsync(this.oneTimePausePolicyKey(data.pid), policy.redisfy());
                const originPolicy = await this.registPauseTimer(policy);
                return Object.assign(originPolicy, {
                    pauseInfo: {
                        expire: data.expire,
                        activatedTime: data.activatedTime,
                    }
                });
            } catch (e) {
                throw new Error("pause policy error");
            }
        });
        sem.once('Policy:AllInitialized', async () => {
            const oneTimePausePolicyKeys = await rclient.keysAsync(this.oneTimePausePolicyKey('*'));
            await Promise.all(oneTimePausePolicyKeys.map(async (oneTimePausePolicyKey) => {
                try {
                    const policy = new Policy(await rclient.hgetallAsync(oneTimePausePolicyKey));
                    this.registPauseTimer(policy);
                } catch (e) {
                    log.warn('load one time pause policy faied', oneTimePausePolicyKey);
                }
            }))
        });
        sem.on('Policy:Enabled', async (event) => {
            const pid = event.pid;
            pid && await this.unRegistPauseTimer(pid);
        })
    }
    async registPauseTimer(policy) {
        const pid = policy.pid;
        const originPolicy = await pm2.getPolicy(pid);
        if (policy.isExpired()) {
            await pm2.enablePolicy(originPolicy);
        } else {
            await pm2.disablePolicy(originPolicy);
            if (this.timerMap[pid]) clearTimeout(this.timerMap[pid]);
            this.timerMap[pid] = setTimeout(async () => {
                await pm2.enablePolicy(originPolicy);
            }, policy.getExpireDiffFromNow() * 1000);
        }
        return originPolicy;
    }
    async unRegistPauseTimer(pid) {
        log.info('un-register one time pause policy');
        if (this.timerMap[pid]) {
            clearTimeout(this.timerMap[pid]);
        }
        await rclient.delAsync(this.oneTimePausePolicyKey(pid));
    }
}

module.exports = PolicySensor
