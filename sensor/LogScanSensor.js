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

const exec = require('child-process-promise').exec;
const bone = require('../lib/Bone.js');
const PlatformLoader = require('../platform/PlatformLoader.js')

const { delay } = require('../util/util.js')
const Tail = require('../vendor_lib/always-tail.js');

const LOG_FIRERESET = '/home/pi/.forever/firereset.log'

class LogScanSensor extends Sensor {

  constructor() {
    super()
    this.platform = PlatformLoader.getPlatform()
  }

  async run() {
    try {
      if (this.config.fireResetBluetooth && this.platform.isBluetoothAvailable()) {
        if (!this.tailFireReset) this.tailFireReset = new Tail(LOG_FIRERESET)
        if (!this.logFireReset) this.logFireReset = {}

        this.tailFireReset.on('line', this.fireResetBluetoothChecker.bind(this));
      }
    } catch (err) {
      log.error("Failed initializing log watchers", err)
      await delay(1000)
      return this.initWatchers()
    }
  }

  async fireResetBluetoothChecker(data) {
    let sendLine = false;

    if (data.includes('Command Disallowed')) {
      if (
        !this.logFireReset.lastDisallowed ||
        new Date() - this.logFireReset.lastDisallowed > this.config.bonelogInterval * 1000
      ) {
        this.logFireReset.lastDisallowed = + new Date()
        sendLine = true;
      } else {
        log.debug('Log ignored', data)
      }
    }

    if (data.includes('can\'t init hci')) {
      if (!this.logFireReset.lastInitHci ||
        new Date() - this.logFireReset.lastInitHci > this.config.bonelogInterval * 1000
      ) {
        try {
          await exec('sudo hciconfig | grep hci0')

          // check again after async operation to avoid multiple alarms being sent
          if (this.logFireReset.lastInitHci &&
            new Date() - this.logFireReset.lastInitHci < this.config.bonelogInterval * 1000
          ) {
            log.debug('Log ignored', data)
            return
          }

          this.logFireReset.lastInitHci = + new Date()
          sendLine = true
        } catch(e) { }
      } else {
        log.debug('Log ignored', data)
      }
    }

    if (sendLine) {
      log.error('FireReset bluetooth error found:', data)
      bone.logAsync("error", {
        type: 'FIREWALLA.LogScan.fireResetBluetooth',
        msg: data
      });
    }
  }
}

module.exports = LogScanSensor;
