/*    Copyright 2023 Firewalla Inc.
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
const fc = require('../net2/config.js');
const Monitorable = require('../net2/Monitorable.js')
const sem = require('./SensorEventManager.js').getInstance();
const extensionManager = require('./ExtensionManager.js')

const _ = require('lodash');

class MonitorablePolicyPlugin extends Sensor {
  async run() {
    this.systemSwitch = false;
    this.adminSystemSwitch = false;
    this.settings = { }
    extensionManager.registerExtension(this.config.policyName, this, {
      applyPolicy: this.applyPolicy,
    });

    this.hookFeature(this.config.featureName);

    sem.on(`${this.featureName.toUpperCase()}_REFRESH`, async (event) => {
      try {
        await this.applyAll()
      } catch(err) {
        log.error('Error refreshing', this.featureName, err)
      }
    });

    sem.on(`${this.featureName.toUpperCase()}_RESET`, async () => {
      try {
        await fc.disableDynamicFeature(this.featureName)
        for (const guid in this.settings) this.settings[guid] = 0
        this.applyAll()
      } catch (err) {
        log.error('Error resetting', this.featureName, err)
      }
    });
  }

  async job() { }

  async apiRun() { }

  policyToSwitch(policy) {
    // false means unset, all for backward compatibility and system consistency
    if (_.isObject(policy))
      return policy.state === true ? 1 : policy.state === false ? 0 : -1
    else
      return policy === true ? 1 : policy === false ? 0 : -1
  }

  async applyPolicy(monitorable, ip/*deprecating*/, policy) {
    if (!(monitorable instanceof Monitorable)) {
      log.error('Invalid monitorable')
      return;
    }
    const guid = monitorable.getGUID()
    log.info("Applying policy:", monitorable.constructor.getClassName(), guid, policy);

    try {
      if (guid === '0.0.0.0') {
        this.systemSwitch = this.policyToSwitch(policy) == 1 ? true : false
        return this.applySystem();
      }

      this.settings[guid] = this.policyToSwitch(policy)
      await this.applyMonitorable(monitorable, this.settings[guid]);

    } catch (err) {
      log.error("Got error when applying family protect policy", err);
    }
  }

  async applyAll() {
    try {
      await this.applySystem();

      for (const guid in this.settings) {
        const monitorable = Monitorable.getInstance(guid)
        if (!monitorable) this.settings[guid] = 0;
        await this.applyMonitorable(monitorable, this.settings[guid]);
        if (!monitorable) delete this.settings[guid]
      }
    } catch (err) {
      log.error('Failed to apply family policy', err)
    }
  }

  async applySystem() {
    if (this.systemSwitch) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async systemStart() { }
  async systemStop() { }

  // doesn't apply to System/HostManager
  async applyMonitorable(monitorable, setting) {
    if (setting == 1)
      return this.moniotrableStart(monitorable)
    else if (setting == -1)
      return this.moniotrableStop(monitorable)
    else
      return this.moniotrableReset(monitorable)
  }

  async moniotrableStart(monitorable) {}
  async moniotrableStop(monitorable) {}
  async moniotrableReset(monitorable) {}

  // global on/off
  async globalOn() {
    await super.globalOn()
    this.adminSystemSwitch = true;
    await this.applyAll();
  }

  async globalOff() {
    await super.globalOff()
    this.adminSystemSwitch = false;
    await this.applyAll();
  }
}

module.exports = MonitorablePolicyPlugin;
