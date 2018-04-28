/*    Copyright 2016 Firewalla LLC
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

const sem = require('../sensor/SensorEventManager.js').getInstance();

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const extensionManager = require('./ExtensionManager.js')

const FRPManager = require('../extension/frp/FRPManager.js')
const fm = new FRPManager()
const frp = fm.getVPNRelayFRP()

class VPNRelaySensor extends Sensor {
  constructor() {
    super();
  }

  run() {   
    extensionManager.registerExtension("vpnRelay", this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    })
  }

  applyPolicy(policy) {
    log.info("Applying policy:", policy, {})
    const state = policy && policy.state
    const server = policy && policy.server
    const token = policy && policy.token

    if(token) {
      frp.token = token
    }

    if(server) {
      frp.server = server
    }    
    
    if(state === true) {
      return this.start()
    } else {
      return this.stop()
    }

  }
  
  start() {
    return frp.start()
  }

  stop() {
    return frp.stop()
  }
}

module.exports = VPNRelaySensor;
