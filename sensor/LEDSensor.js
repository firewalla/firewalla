/*    Copyright 2016-2020 Firewalla INC
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
const fc = require('../net2/config.js');
const extensionManager = require('./ExtensionManager.js')
const platform = require('../platform/PlatformLoader.js').getPlatform();
const POLICY_KEYNAME = 'led';

const Message = require('../net2/Message.js');
const SYS_STATES_KEY = 'sys:states';


class LEDSensor extends Sensor {

  constructor() {
    super()
    this.adminSwitch = false;
    this.cachedPolicy = {};
  }

  async applyCachedPolicy() {
    log.info("Apply cached policy ... ");
    log.debug("cachedPolicy: ", this.cachedPolicy);
    try {
      if ( this.cachedPolicy ) {
        this.applyPolicySystem(this.cachedPolicy);
      }
    } catch (err) {
      log.error( "failed to apply cached policy: ", err);
    }
  }

  async globalOn() {
    log.info("run globalOn ...");
    this.adminSwitch = true;
    this.applyCachedPolicy();
  }

  async globalOff() {
    log.info("run globalOff ...");
    this.adminSwitch = false;
    this.applyCachedPolicy();
  }

  async run() {
    
    log.info("run LEDSensor ...");

    /*
     * apply policy upon policy change or startup
     */
    extensionManager.registerExtension(POLICY_KEYNAME, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });

  }

  applyPolicySystem(systemConfig) {
    log.info("Apply fan policy change with systemConfig:",systemConfig);

    try {
      const runtimeConfig = systemConfig || this.config;
      log.debug("runtimeConfig: ",runtimeConfig);
      platform.configLED(runtimeConfig);
    } catch (err) {
      log.error("failed to apply monitoring policy change: ", err);
    }
    return;
  }

  async applyPolicy(host, ip, policy) {
    log.info(`Apply fan policy with host(${host && host.o && host.o.mac}), ip(${ip})`);
    log.debug("policy: ",policy);
    try {
        if (ip === '0.0.0.0') {
            this.cachedPolicy = policy;
            this.applyPolicySystem(policy);
        } else {
            log.warn(`LED policy for a device(${ip}) is NOT supported`);
            return;
        }
    } catch (err) {
        log.error("Got error when applying policy", err);
    }
  }

}

module.exports = LEDSensor;
