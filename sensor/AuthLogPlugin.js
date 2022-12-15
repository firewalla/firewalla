/*    Copyright 2016-2022 Firewalla Inc.
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
        setInterval(() => {
            this._runCheck(interval, threshold);
        }, interval * 60 * 1000);
        this._runCheck(interval, threshold);
    }

    async _runCheck(interval, threshold) {
      try {
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
      } catch(err) {
        log.error('Failed to run AuthLogPlugin', err)
      }
    }

    async _triggerGuessingAlarm(ip, guessCount) {
      log.debug('Generating alarm on', ip)
      const alarmPayload = {
        "p.guessCount": guessCount
      }
      const v4 = new Address4(ip).isValid()
      // if non-local IP, use WAN, lastb doesn't have interface info, guess with the active WAN here
      const intf = sysManager.getInterfaceViaIP(ip, false) || sysManager.getWanInterfaces().find(i => i.active)
      if (!intf || intf.type == 'wan') {
        if (intf) {
          alarmPayload["p.device.ip"] = v4 ? intf.ip_address : intf.ip6_addresses && intf.ip6_addresses[0]
          alarmPayload["p.device.mac"] = intf.mac_address
        }

        alarmPayload["p.dest.ip"] = ip;
        alarmPayload["p.device.name"] = await f.getBoxName() || "Firewalla";
        alarmPayload["p.local_is_client"] = "0";
      } else {
        alarmPayload["p.device.ip"] = ip;
        alarmPayload["p.dest.ip"] = v4 ? intf.ip_address : intf.ip6_addresses && intf.ip6_addresses[0]
        alarmPayload["p.dest.name"] = await f.getBoxName() || "Firewalla";
        alarmPayload["p.dest.mac"] = intf.mac_address
        alarmPayload["p.local_is_client"] = "1";
      }
      const msg = `${ip} appears to be guessing SSH passwords (seen in ${guessCount} connections).`
      const alarm = new Alarm.BroNoticeAlarm(new Date() / 1000, ip, "SSH::Password_Guessing", msg, alarmPayload);
      am2.enqueueAlarm(alarm);
    }

}

module.exports = AuthLogPlugin;
