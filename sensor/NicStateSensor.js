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
const exec = require('child-process-promise').exec;
const fsp = require('fs').promises;
const _ = require('lodash');
const rclient = require('../util/redis_manager.js').getRedisClient();

class NicStateSensor extends Sensor {
  async run() {
    this.lastSpeed = {};
    this.ethInfo = {};
    setInterval(() => {
      this.check().catch((err) => {
        log.error(`Failed to check NIC states`, err.message);
      });
    }, 20000);
    setInterval(() => {
      this.updateCounter().catch((err) => {
        log.error(`Failed to update eth info counter`, err.message);
      });
    }, 60000);
  }

  async check() {
    const states = await platform.getNicStates();
    for (const nic of Object.keys(states)) {
      const state = states[nic];
      const maxSpeed = await platform.getMaxLinkSpeed(nic);
      state.maxSpeed = maxSpeed;
      const eventObj = {iface: nic, carrier: state.carrier, speed: state.speed, maxSpeed: maxSpeed, duplex: state.duplex};
      // do not emit state event if carrier is 0 or speed is unavailable
      if (maxSpeed && !isNaN(maxSpeed) && state.carrier == "1" && !isNaN(state.speed) && Number(state.speed) > 0) {
        // different platform may have different max speed as ok_value
        eventObj.ok_value = Number(maxSpeed);
        if (Number(state.speed) == this.lastSpeed[nic]) // only send state event if the same speed has been detected in two consecutive valid results to reduce abnormal events due to fluctuation or initialization
          era.addStateEvent(Constants.STATE_EVENT_NIC_SPEED, nic, Number(state.speed), eventObj).catch((err) => {});
        this.lastSpeed[nic] = Number(state.speed);
      }
    }
  }

  async updateCounter() {
    const nics = platform.getAllNicNames();
    const items = ["tx_timeout", "link_up", "link_down"];
    for (const nic of nics) {
      for (const item of items) {
        let key = null;
        let result = null;
        switch (item) {
          case "tx_timeout": {
            key = `${nic}_tx_timeout`;
            result = await exec(`cat /sys/class/net/${nic}/queues/tx-*/tx_timeout`)
              .then((output) => output.stdout && output.stdout.trim().split('\n').filter(line => !isNaN(line)).reduce((sum, line) => sum + Number(line), 0))
              .catch((err) => 0);
            break;
          }
          case "link_up": {
            key = `${nic}_link_up`;
            result = await fsp.readFile(`/sys/class/net/${nic}/carrier_up_count`, {encoding: "utf8"}).then(content => Number(content.trim())).catch((err) => 0);
            break;
          }
          case "link_down": {
            key = `${nic}_link_down`;
            result = await fsp.readFile(`/sys/class/net/${nic}/carrier_down_count`, {encoding: "utf8"}).then(content => Number(content.trim())).catch((err) => 0);
            break;
          }
        }
        if (key && !isNaN(result)) {
          let diff = 0;
          // if key does not exist in this.ethInfo, it is right after the process restart, do not add diff to total in redis
          if (_.has(this.ethInfo, key))
            diff = this.ethInfo[key] <= result ? result - this.ethInfo[key] : result;
          this.ethInfo[key] = result;
          const prevTotal = Number(await rclient.hgetAsync(Constants.REDIS_KEY_ETH_INFO, key) || 0);
          const total = Math.max(prevTotal + diff, result);
          await rclient.hsetAsync(Constants.REDIS_KEY_ETH_INFO, key, total);
        }
      }
    }
  }
}

module.exports = NicStateSensor;