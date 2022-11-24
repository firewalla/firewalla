/*    Copyright 2016-2020 Firewalla Inc.
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
const f = require('../net2/Firewalla.js');
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const sysManager = require('../net2/SysManager.js');
const {Address4} = require('ip-address');
const util = require('util');
const cp = require('child_process');
const execAsync = util.promisify(cp.exec);

const kw = "ssh:notty";
const _ = require('lodash');

class AuthLogPlugin extends Sensor {

    run() {
        const interval = this.config.interval || 5;
        const threshold = this.config.threshold || 30;
        setInterval( async () => {
            await this._runCheck(interval, threshold);
        }, interval * 60 * 1000);
        (async () => {
            await this._runCheck(interval, threshold);
        })();
    }

    async _runCheck(interval, threshold) {
        log.debug("Start to check ssh login attempts");
        let sshLoginFailIPs;
        const loginFailStr = await execAsync(`sudo lastb -s -${interval}min -t now |awk '$2 == "${kw}" { print $3 }'`).then(result => result.stdout.trim()).catch(() => null);
        if (loginFailStr) {
            sshLoginFailIPs = loginFailStr.split("\n");
            if (!_.isArray(sshLoginFailIPs)) return;
            const sshLoginFailRst = sshLoginFailIPs.reduce( (acc, curr) => {
                acc[curr] ? acc[curr]++ : acc[curr] = 1
                return acc;
            }, {});
            for (const ip in sshLoginFailRst) {
                const guessCount = sshLoginFailRst[ip];
                if (guessCount > threshold) {
                    await this._triggerGuessingAlarm(ip, guessCount);
                }
            }
        } 
    }

    _getFwIP(lh) {
        if (new Address4(lh).isValid()) {
            const inf = sysManager.getInterfaceViaIP(lh, false);
            if (inf) return inf.ip_address
        } else {
            const intf = sysManager.getInterfaceViaIP(lh, false);
            if (intf) return intf && intf.ip6_addresses && intf.ip6_addresses[0];
        }
    }

    async _triggerGuessingAlarm(lh, guessCount) {
        const alarmPayload = {
            "p.guessCount": guessCount
        }
        const firewallaIP = this._getFwIP(lh);
        if (!firewallaIP) {
            alarmPayload["p.dest.ip"] = lh;
            alarmPayload["p.device.name"] = await f.getBoxName() || "Firewalla";
            alarmPayload["p.local_is_client"] = "0";
        } else {
            alarmPayload["p.device.ip"] = lh;
            alarmPayload["p.dest.ip"] = firewallaIP;
            alarmPayload["p.local_is_client"] = "1";
        }
        const msg = `${lh} appears to be guessing SSH passwords (seen in ${guessCount} connections).`
        const alarm = new Alarm.BroNoticeAlarm(new Date() / 1000, lh, "SSH::Password_Guessing", msg, alarmPayload);
        am2.enqueueAlarm(alarm);
    }

}

module.exports = AuthLogPlugin;