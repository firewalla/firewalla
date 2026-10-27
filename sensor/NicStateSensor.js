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
const fs = require('fs');
const fsp = fs.promises;
const _ = require('lodash');
const rclient = require('../util/redis_manager.js').getRedisClient();
const ethCounters = require('../net2/EthCounters.js');

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
      // not awaited by setInterval, so guard against a slow round overlapping the next one:
      // the read-modify-write of the total is not atomic and both rounds would add the same diff
      if (!this.updatingDriverCounter) {
        this.updatingDriverCounter = true;
        this.updateDriverCounter().catch((err) => {
          log.error(`Failed to update driver counter`, err.message);
        }).finally(() => { this.updatingDriverCounter = false; });
      }
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
            result = await fsp.readdir(`/sys/class/net/${nic}/queues`)
              .then(entries => Promise.all(
                entries.filter(entry => entry.startsWith('tx-'))
                  .map(entry => fsp.readFile(`/sys/class/net/${nic}/queues/${entry}/tx_timeout`, {encoding: "utf8"})
                    .then(content => Number(content.trim()))
                    .catch(() => NaN))
              ))
              .then(values => values.filter(v => !isNaN(v)).reduce((sum, v) => sum + v, 0))
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

  // the counters that come from the driver, see net2/EthCounters.js. A new counter goes in that
  // table rather than in updateCounter above, which keeps reading the sysfs files it reads today
  async updateDriverCounter() {
    for (const nic of platform.getEthernetNicNames()) {
      // getEthernetNicNames is a static list on most platforms, do not keep forking ethtool at
      // a port this box does not have, same as getEthernetInfo in SysInfo
      if (!await fsp.access(`/sys/class/net/${nic}/ifindex`, fs.constants.F_OK).then(() => true).catch(() => false))
        continue;
      const counters = await ethCounters.collect(nic);
      // the NIC could not be read this round, leave the stored totals alone. Overwriting them
      // would both lose the lifetime total and tell the app the port cannot count pause frames
      if (!counters)
        continue;
      for (const metric in ethCounters.ETH_COUNTERS) {
        // collect() only reads the ethtool-sourced counters, a counter from another source is
        // not missing here, it was never looked for
        if (ethCounters.ETH_COUNTERS[metric].source !== 'ethtool')
          continue;
        if (!ethCounters.ETH_COUNTERS[metric].cumulative)
          continue;
        const key = `${nic}_${ethCounters.ETH_COUNTERS[metric].key}`;
        const result = counters[metric];
        // the driver has no such counter on this NIC. -1, not 0, so that a port whose driver
        // cannot count pause frames is not read as a port that has seen none - the same
        // convention as <nic>_crc = -1 in SysInfo. A key that is absent altogether only means
        // the first round has not run yet
        if (result === undefined) {
          // Only when nothing is stored yet, and so also only once rather than every minute.
          // A NIC swapped for one without the counter, or a counter renamed by a driver
          // upgrade, must not turn the lifetime total this feature exists to keep into -1
          if (await rclient.hgetAsync(Constants.REDIS_KEY_ETH_INFO, key) === null)
            await rclient.hsetAsync(Constants.REDIS_KEY_ETH_INFO, key, -1);
          continue;
        }
        if (isNaN(result))
          continue;
        // same lifetime total as updateCounter, the driver counters reset on reboot
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

module.exports = NicStateSensor;
