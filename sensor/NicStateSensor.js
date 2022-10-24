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

const Sensor = require('./Sensor.js').Sensor;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const era = require('../event/EventRequestApi.js');
const Constants = require('../net2/Constants.js');

const stateVals = {
  // bit 1 - 3 reserved for speed
  "speed": {
    "10": 0x2,
    "100": 0x4,
    "1000": 0x6,
    "2500": 0x8
  },
  // bit 0 - 0 reserved for duplex
  "duplex": {
    "full": 0x0,
    "half": 0x1
  }
};

class NicStateSensor extends Sensor {
  async run() {
    setInterval(() => {
      this.check().catch((err) => {
        log.error(`Failed to check NIC states`, err.message);
      });
    }, 60000);
  }

  async check() {
    const states = await platform.getNicStates();
    for (const nic of Object.keys(states)) {
      const state = states[nic];
      const maxSpeed = await platform.getMaxLinkSpeed(nic);
      state.maxSpeed = maxSpeed;
      if (maxSpeed && state.carrier == "1" && !isNaN(state.speed) && Number(state.speed) > 0) {
        if (state.speed < maxSpeed || state.duplex && state.duplex != "full") {
          // each abnormal value in state object will have different bits set in state value
          era.addStateEvent(Constants.STATE_EVENT_NIC_STATE, nic, this.getStateVal(state), {iface: nic, carrier: state.carrier, speed: state.speed, maxSpeed: maxSpeed, duplex: state.duplex}).catch((err) => {});
          continue;
        }
      }
      // if carrier is 0, or speed/maxSpeed is unavailable, or speed matches with the maxSpeed, set the state to 0
      era.addStateEvent(Constants.STATE_EVENT_NIC_STATE, nic, 0, {iface: nic, carrier: state.carrier, speed: state.speed, maxSpeed: maxSpeed, duplex: state.duplex}).catch((err) => {});
    }
  }

  getStateVal(state) {
    let val = 0;
    for (const key of Object.keys(state)) {
      if (stateVals.hasOwnProperty(key)) {
        val += stateVals[key][state[key]] || 0;
      }
    }
    return val;
  }
}

module.exports = NicStateSensor;