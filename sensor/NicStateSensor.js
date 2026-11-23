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
      // not awaited by setInterval, so guard against a slow round overlapping the next one:
      // the read-modify-write of the total is not atomic and both rounds would add the same diff
      if (this.updatingCounters)
        return;
      this.updatingCounters = true;
      this.updateCounters().catch((err) => {
        log.error(`Failed to update eth info counter`, err.message);
      }).finally(() => { this.updatingCounters = false; });
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

  // One round over every counter in net2/EthCounters.js. A new counter is a row in that table,
  // not code here
  async updateCounters() {
    const ethernetNics = new Set(platform.getEthernetNicNames());
    for (const nic of platform.getAllNicNames()) {
      // a NIC the platform lists but that is not there, e.g. the PSE USB port unplugged, or one
      // of the ports a Crystal was not built with. Nothing can be read off it, but the legacy
      // counters wrote their 0 for it before this table existed and the cloud reads those keys,
      // so only the counters this table owns are skipped
      const present = await fsp.access(`/sys/class/net/${nic}/ifindex`, fs.constants.F_OK).then(() => true).catch(() => false);
      // at most one `ethtool -S` and one `ethtool -i` per NIC per round, and none at all for a
      // NIC whose counters all come out of sysfs
      const context = ethCounters.nicContext(nic);
      for (const metric in ethCounters.ETH_COUNTERS) {
        const spec = ethCounters.ETH_COUNTERS[metric];
        if (!spec.cumulative || !ethCounters.appliesTo(metric, ethernetNics.has(nic)))
          continue;
        if (!present && !spec.legacy)
          continue;
        const key = `${nic}_${spec.key}`;
        const value = await ethCounters.read(metric, context);
        // the counter could not be read this round, which says nothing about whether the NIC
        // has it: leave the stored total alone rather than lose it or call the port unable
        if (value === null)
          continue;
        // the NIC cannot count it. -1, not 0, so that a port whose driver cannot count CRC
        // errors is not read as a port that has seen none - the same convention as
        // <nic>_crc = -1 in SysInfo. A key that is absent altogether only means the first
        // round has not run yet
        if (value === undefined) {
          // Only when nothing is stored yet, and so also only once rather than every minute.
          // A NIC swapped for one without the counter, or a counter renamed by a driver
          // upgrade, must not turn the lifetime total this feature exists to keep into -1
          if (await rclient.hgetAsync(Constants.REDIS_KEY_ETH_INFO, key) === null)
            await rclient.hsetAsync(Constants.REDIS_KEY_ETH_INFO, key, -1);
          continue;
        }
        if (isNaN(value))
          continue;
        await this.accumulate(key, value);
      }
    }
  }

  // one more sample of a counter that only grows. The counters themselves go back to 0 on a
  // reboot, a driver reset or a link flap, so the lifetime total is the sum of the diffs,
  // floored at what the NIC itself reports
  async accumulate(key, value) {
    let diff = 0;
    // if key does not exist in this.ethInfo, it is right after the process restart, do not add diff to total in redis
    if (_.has(this.ethInfo, key))
      diff = this.ethInfo[key] <= value ? value - this.ethInfo[key] : value;
    this.ethInfo[key] = value;
    const prevTotal = Number(await rclient.hgetAsync(Constants.REDIS_KEY_ETH_INFO, key) || 0);
    const total = Math.max(prevTotal + diff, value);
    await rclient.hsetAsync(Constants.REDIS_KEY_ETH_INFO, key, total);
  }
}

module.exports = NicStateSensor;
