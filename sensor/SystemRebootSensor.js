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
const os = require('os');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const era = require('../event/EventRequestApi.js');
const { execFile } = require('child-process-promise');
const f = require('../net2/Firewalla.js');
const Config = require('../net2/config.js');
const localApi = require('../util/localApi.js');
const otaRebootMarker = require('../util/otaRebootMarker.js');
const { delay } = require('../util/util.js');
const HB_FILE = `${f.getRuntimeInfoFolder()}/heartbeat`;
// vulcan.service is started by main-run's prep, which may not have run yet
const OTA_TRIES = 10;
const OTA_RETRY_INTERVAL = 60000;

class SystemRebootSensor extends Sensor {
  async checkReboot() {
    const REBOOT_FLAG_FILE = '/dev/shm/system_reboot.touch';
    if (fs.existsSync(REBOOT_FLAG_FILE)) {
      log.debug("system reboot processed before, NO more action event needed");
    } else {
      log.debug("system reboot not processed yet, sending action event");
      if (!await this.checkOtaReboot()) {
        const last = await this.getLastHeartbeatTime();
        const dur = last && Date.now() - os.uptime()*1000 - Number(last);
        if (dur && dur  > 300000){ // do not generate event if the box has been offline for less than 5 minutes
          era.addActionEvent("system_reboot", 1, {last: last, duration: dur});
        }
      }
    }
    // use sudo to generate file in /dev/shm, IPC objects of system users will not be removed even if RemoveIPC=yes in /etc/systemd/logind.conf
    await execFile("sudo", ["rm", "-f", REBOOT_FLAG_FILE]).catch((err) => {}); // regenerate the file to make sure it is owned by root
    await execFile("sudo", ["touch", REBOOT_FLAG_FILE]).catch((err) => {
      log.error(`Failed to touch ${REBOOT_FLAG_FILE}`, err.message);
    });
  }

  // true if this boot finished an OTA image upgrade and ota_reboot_complete was sent
  async checkOtaReboot() {
    const marker = await otaRebootMarker.read();
    if (!marker)
      return false;
    const done = await this.waitOtaImage(marker.build);
    if (done) {
      await era.addActionEvent('ota_reboot_complete', 1, marker);
      log.info(`OTA reboot for ${marker.build} complete`);
    }
    await otaRebootMarker.remove();
    return done;
  }

  // whether vulcan reports the build as running, asking a few times while it starts up
  async waitOtaImage(build) {
    const baseUrl = Config.getConfig().apiSensors.OtaSensor.baseUrl;
    for (let i = 0; i < OTA_TRIES; i++) {
      if (i > 0)
        await delay(OTA_RETRY_INTERVAL);
      const resp = await localApi.call(baseUrl, 'GET', '/ota/image', null, { timeout: 10000, errorCode: localApi.gatewayErrorCode });
      const image = resp.code === 200 && resp.body && resp.body.image;
      if (!image) {
        log.info('OTA reboot check: vulcan not ready', resp.code, resp.msg);
      } else if (image.build !== build) {
        log.warn(`OTA reboot for ${build} not complete, vulcan reports ${image.build}`);
        return false;
      } else if (image.reboot_required) {
        // vulcan may answer before its startup clears the flag for this boot
        log.info(`OTA reboot check: vulcan still reports a reboot required for ${build}`);
      } else {
        return true;
      }
    }
    log.warn(`OTA reboot for ${build} not confirmed by vulcan after ${OTA_TRIES} tries`);
    return false;
  }

  async getLastHeartbeatTime() {
    return fs.readFileAsync(HB_FILE, {encoding: "utf8"}).catch((err) => null);
  }

  async setLastHeartbeatTime(ts = Date.now()) {
    let fd;
    try {
      fd = await fs.openAsync(HB_FILE, 'w');
      await fs.writeAsync(fd, String(ts));
      await fs.fsyncAsync(fd);
    } catch (err) {
      log.error(`Failed to save heartbeat into ${HB_FILE}`, err.message);
    } finally {
      if (fd !== undefined) await fs.closeAsync(fd).catch((err) => {});
    }
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