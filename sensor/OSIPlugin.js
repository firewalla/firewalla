/*    Copyright 2016-2021 Firewalla Inc.
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

const exec = require('child-process-promise').exec;
const log = require('../net2/logger.js')(__filename);
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Sensor = require('./Sensor.js').Sensor;
const Message = require('../net2/Message.js');

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

class OSIPlugin extends Sensor {
  run() {
    sem.on(Message.MSG_OSI_MATCH_ALL_KNOB_OFF, () => {
        log.info("Flushing osi_match_all_knob");
        exec("sudo ipset flush -! osi_match_all_knob").catch((err) => {});
    });

    sem.on(Message.MSG_OSI_MAC_VERIFIED, (event) => {
        if (event.mac) {
            log.info(`Marked mac ${event.mac} as verified`);
            exec(`sudo ipset add -! osi_verified_mac_set ${event.mac}`).catch((err) => { });
        } else {
            log.error("No mac found in MSG_OSI_MAC_VERIFIED event");
        }
    });

    sem.on(Message.MSG_OSI_SUBNET_VERIFIED, (event) => {
        if (event.subnet) {
            log.info(`Marked subnet ${event.subnet} as verified`);
            exec(`sudo ipset add -! osi_verified_subnet_set ${event.subnet}`).catch((err) => { });
        } else {
            log.error("No subnet found in MSG_OSI_SUBNET_VERIFIED event");
        }
    });

    // force disable OSI after 30 mins, as a protection
    setTimeout(() => {
        exec("sudo ipset flush -! osi_mac_set").catch((err) => {});
        exec("sudo ipset flush -! osi_subnet_set").catch((err) => {});
    }, 30 * 60 * 1000)

    setInterval(() => {
        this.updateOSIPool();
    }, 30 * 1000)
  }

  async updateOSIPool() {
    const macs = [];

    const profileIds = await hostManager.getAllActiveStrictVPNClients();
    log.info("XXX:", profileIds);
  }
}

module.exports = OSIPlugin;
