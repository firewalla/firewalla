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
const exec = require('child-process-promise').exec;
const sem = require('../sensor/SensorEventManager.js').getInstance();

const Sensor = require('./Sensor.js').Sensor;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const scheduler = require('../util/scheduler');
const Message = require('../net2/Message.js');


class NicCalibrationSensor extends Sensor {
  async run() {
    if (!platform.isNicCalibrationApplicable())
      return;  
    this.scheduledJob = new scheduler.UpdateJob(this.checkAndApply.bind(this), 10000);
    this.scheduledJob.exec().catch((err) => {
        log.error(`Failed to apply nic calibration task`, err);
    });

    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      this.scheduledJob.exec().catch((err) => {
        log.error(`Failed to apply nic calibration task`, err);
      });
    });
  }

  async onConfigChange(oldConfig) {
    this.scheduledJob.exec().catch((err) => {
        log.error(`Failed to apply nic calibration task`, err);
    });
  }

  async checkAndApply() {
    let needReset = false;
    if (this.isConfigEnabled() && await this.isHWEnabled()) {
      await platform.setNicCalib(this.getConfigParams()).catch((err) => {
        log.error(`Failed to set nic calib, will reset back to default`, err);
        needReset = true;
      });
    } else {
      needReset = true;
    }
    if (needReset) {
      await platform.resetNicCalib().catch((err) => {
        log.error(`Failed to reset nic calib`, err);
      });
    }
  }

  isConfigEnabled() {
    if (this.config && this.config.ecali && this.config.ecali.enabled == true)
        return true;
    return false;
  }

  async isHWEnabled() {
    return platform.isNicCalibrationHWEnabled();
  }

  getConfigParams() {
    return this.config && this.config.ecali && this.config.ecali.value;
  }
}

module.exports = NicCalibrationSensor;