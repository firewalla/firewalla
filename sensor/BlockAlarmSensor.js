/*    Copyright 2016-2026 Firewalla Inc.
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
const _ = require('lodash');
const net = require('net');
const LRU = require('lru-cache');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('../net2/Message.js');
const Constants = require('../net2/Constants.js');
const CloudConfigLoader = require('./CloudConfigLoader.js');
const { matchFilter, isValidFilter } = require('./BlockStatsFilter.js');
const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const am2 = new AlarmManager2();

// not cloud tunable, the cloud only picks which blocks alarm
const COOLDOWN_SECS = 86400;
const MAX_ALARMS_PER_DEVICE = 10;
const DEVICE_WINDOW_SECS = 3600;
const MAX_ALARMED = 2048;
const MAX_DEVICES = 512;
const MAX_IN_FLIGHT = 20;
const MAX_FAILED = 256;

// Raises ALARM_CATEGORY_BLOCK for the category blocks that blockAlarmSettings selects, once per
// device, domain and category per cooldown. Off by default, a non-empty cloud list turns it on
class BlockAlarmSensor extends Sensor {
  constructor(config) {
    super(config);
    // the local default is in place before the first event, the cloud config replaces it when it arrives
    this.settings = this._validateSettings(this.config.blockAlarmSettings);
    this.alarmed = new LRU({ max: MAX_ALARMED, maxAge: COOLDOWN_SECS * 1000 }); // device|dest|category
    this.deviceCounts = new LRU({ max: MAX_DEVICES, maxAge: DEVICE_WINDOW_SECS * 1000 }); // device => { count, resetAt }
    this.inFlight = new Set(); // keys whose alarm is being built
    this.failLogged = new LRU({ max: MAX_FAILED, maxAge: DEVICE_WINDOW_SECS * 1000 }); // keys whose failure is logged
    this.cloudConfigLoader = new CloudConfigLoader({
      cacheKey: Constants.REDIS_KEY_BLOCK_ALARM_CLOUD_CONFIG,
      hashsetName: Constants.KEY_BLOCK_ALARM_CONFIG,
      label: 'block alarm',
      apply: cloudConfig => this.applyConfig(cloudConfig)
    });
    sem.on(Message.MSG_BLOCK_FLOW_STATS_UPDATE, event => this._onBlockFlow(event));
  }

  async run() {
    await this.cloudConfigLoader.start();
  }

  // same rule as BlockStatsSensor: a non-empty cloud list replaces the local one, an empty or missing one keeps it
  applyConfig(cloudConfig) {
    const cloudSettings = cloudConfig && cloudConfig.blockAlarmSettings;
    this.settings = this._validateSettings(!_.isEmpty(cloudSettings) ? cloudSettings : this.config.blockAlarmSettings);
  }

  // drops unusable settings, so a bad cloud push disables that setting rather than throwing on every event
  _validateSettings(settings) {
    if (!_.isArray(settings)) return [];
    return settings.filter(setting => {
      if (_.isPlainObject(setting) && isValidFilter(setting.filter)) return true;
      log.error('Ignoring block alarm setting without a usable filter', setting);
      return false;
    });
  }

  // runs on every category/country block, so everything before the async part is in memory only
  _onBlockFlow(event) {
    try {
      this._handleBlockFlow(event);
    } catch (err) {
      log.error('Failed to handle block flow event', err.message);
    }
  }

  _handleBlockFlow(event) {
    const { device, dest, bType, bTarget } = event;
    if (bType !== 'category' || _.isEmpty(this.settings)) return;
    // box level block has no device to alarm, and an IP block has no domain to show, the dns block of the domain alarms
    if (device.startsWith(`${Constants.NS_INTERFACE}:`) || net.isIP(dest)) return;
    if (!this.settings.some(setting => matchFilter(setting.filter, event))) return;

    const key = `${device}|${dest}|${bTarget}`;
    if (this.alarmed.has(key) || this.inFlight.has(key)) return;
    if (this.inFlight.size >= MAX_IN_FLIGHT || this._overDeviceCap(device)) {
      log.verbose('Skip block alarm', key);
      return;
    }

    this.inFlight.add(key);
    this._raiseAlarm(event)
      // set after the job is saved, so a failure is retried by the next event
      .then(saved => saved && this.alarmed.set(key, true))
      .catch(err => {
        // a failing key retries on every event, so only its first failure is an error
        const first = !this.failLogged.has(key);
        this.failLogged.set(key, true);
        log[first ? 'error' : 'verbose']('Failed to raise block alarm', key, err.message);
      })
      .finally(() => this.inFlight.delete(key));
  }

  // counts the attempt when it passes, so a burst of distinct domains cannot flood the alarm queue
  _overDeviceCap(device) {
    const now = Date.now();
    let rec = this.deviceCounts.get(device);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + DEVICE_WINDOW_SECS * 1000 };
      this.deviceCounts.set(device, rec);
    }
    if (rec.count >= MAX_ALARMS_PER_DEVICE) return true;
    rec.count++;
    return false;
  }

  // resolves to whether the alarm job was saved
  async _raiseAlarm({ device, dest, bTarget, fd }) {
    const deviceFields = await am2.getDeviceAlarmFields({ mac: device, withIntf: true });
    if (!deviceFields) {
      log.verbose('No device to alarm for', device);
      return false;
    }
    const alarm = new Alarm.CategoryBlockAlarm(new Date() / 1000, deviceFields["p.device.ip"], {
      ...deviceFields,
      "p.dest.name": dest,
      "p.dest.category": bTarget,
      "p.local_is_client": fd === 'out' ? "0" : "1", // 'out' is initiated from outside
      "p.cooldown": COOLDOWN_SECS,
      "p.ignoreDestIntel": "1" // the domain is all there is, as in ACLAlarmLogPlugin
    });
    await am2.enrichDeviceInfo(alarm);
    return am2.enqueueAlarm(alarm);
  }
}

module.exports = BlockAlarmSensor;
