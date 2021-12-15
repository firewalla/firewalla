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

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const scheduler = require('../util/scheduler.js');
const Message = require('../net2/Message.js');

class PcapPlugin extends Sensor {

  async run() {
    this.enabled = false;
    this.hookFeature(this.getFeatureName());
    const restartJob = new scheduler.UpdateJob(this.restart.bind(this), 5000);
    await this.initLogProcessing();
    sem.on(Message.MSG_PCAP_RESTART_NEEDED, (event) => {
      if (this.enabled) {
        log.info(`Received event ${Message.MSG_PCAP_RESTART_NEEDED}, will restart pcap tool ${this.constructor.name}`);
        restartJob.exec().catch((err) => {
          log.error(`Failed to restart pcap job ${this.constructor.name}`, err.message);
        });
      }
    });
  }

  // this will be invoked only once when the class is loaded
  // the implementation should only create processors for log files from this pcap tool without touching upstream configurations
  async initLogProcessing() {

  }

  async globalOn() {
    this.enabled = true;
    log.info(`Pcap plugin ${this.getFeatureName()} is enabled`);
    await this.restart().catch((err) => {
      log.error(`Failed to start ${this.constructor.name}`, err.message);
    });
  }

  async globalOff() {
    this.enabled = false;
    log.info(`Pcap plugin ${this.getFeatureName()} is disabled`);
    await this.stop().catch((err) => {
      log.error(`Failed to stop ${this.constructor.name}`, err.message);
    });
  }

  async restart() {

  }

  async stop() {

  }

  getFeatureName() {
    return "";
  }
}

module.exports = PcapPlugin;