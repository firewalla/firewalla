/*    Copyright 2020-2022 Firewalla Inc.
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
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const era = require('../event/EventRequestApi.js');
const exec = require('child-process-promise').exec;
const f = require('../net2/Firewalla.js');
const HB_FILE = `${f.getRuntimeInfoFolder()}/heartbeat`;

class SystemRebootSensor extends Sensor {
  async checkReboot() {
    const REBOOT_FLAG_FILE = '/dev/shm/system_reboot.touch';
    if (fs.existsSync(REBOOT_FLAG_FILE)) {
      log.debug("system reboot processed before, NO more action event needed");
    } else {
      log.debug("system reboot not processed yet, sending action event");
      const last = await this.getLastHeartbeatTime();
      if (last)
        era.addActionEvent("system_reboot", 1, {last: last});
    }
    // use sudo to generate file in /dev/shm, IPC objects of system users will not be removed even if RemoveIPC=yes in /etc/systemd/logind.conf
    await exec(`sudo rm -f ${REBOOT_FLAG_FILE}`).catch((err) => {}); // regenerate the file to make sure it is owned by root
    await exec(`sudo touch ${REBOOT_FLAG_FILE}`).catch((err) => {
      log.error(`Failed to touch ${REBOOT_FLAG_FILE}`, err.message);
    });
  }

  async updateHeartbeat() {
    const now = Date.now();
    await this.setLastHeartbeatTime(now);
  }

  async getLastHeartbeatTime() {
    return fs.readFileAsync(HB_FILE, {encoding: "utf8"}).catch((err) => null);
  }

  async setLastHeartbeatTime(ts = Date.now()) {
    return fs.writeFileAsync(HB_FILE, ts, {encoding: "utf8"}).then(() => exec(`sync`)).catch((err) => {
      log.error(`Failed to save heartbeat into ${HB_FILE}`, err.message);
    });
  }

  async run() {
    await this.checkReboot().catch((err) => {
      log.error(`Failed to check reboot`, err.message);
    });
    await this.setLastHeartbeatTime();
    setInterval(() => {
      this.setLastHeartbeatTime();
    }, 60000);
  }

}

module.exports = SystemRebootSensor;