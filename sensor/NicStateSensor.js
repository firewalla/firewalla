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
const rclient = require('../util/redis_manager.js').getRedisClient();
const ethCounters = require('../net2/EthCounters.js');

// see NicStateSensor.accumulate. Every branch keeps the new raw sample, the total only moves
// where the sample can be compared to the one before it
const accumulateLua = `
local total = redis.call('hget', KEYS[1], ARGV[1])
local last = redis.call('hget', KEYS[2], ARGV[1])
local raw = tonumber(ARGV[2])
local resetAt = redis.call('hget', KEYS[1], ARGV[3])
redis.call('hset', KEYS[2], ARGV[1], raw)
-- nothing stored yet, or a counter stored as the -1 of a NIC that could not count it and now
-- can. A port whose counters the app has reset starts at 0 rather than at what the hardware has
-- counted over its life, including when the reset came before the first round stored anything
if total == false or tonumber(total) == nil or tonumber(total) < 0 then
  if resetAt == false then
    redis.call('hset', KEYS[1], ARGV[1], raw)
  else
    redis.call('hset', KEYS[1], ARGV[1], 0)
  end
  return 0
end
-- no raw sample to diff against. Either this is the first round after the upgrade from the
-- version that kept it in memory, where the total was floored at the hardware count and has to
-- stay that way, or a reset dropped it, which leaves the marker below and must stay at its zero
if last == false then
  if raw > tonumber(total) then
    redis.call('hset', KEYS[1], ARGV[1], raw)
  end
  return 0
end
local previous = tonumber(last)
if previous == nil then
  return 0
end
-- a counter that went backwards was reset by the driver, e.g. on a link flap or a reboot, so
-- the whole reading is what the port has counted since
local diff = raw - previous
if previous > raw then
  diff = raw
end
if diff > 0 then
  redis.call('hincrby', KEYS[1], ARGV[1], diff)
end
return diff
`;

class NicStateSensor extends Sensor {
  async run() {
    this.lastSpeed = {};
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
        if (key && !isNaN(result))
          await this.accumulate(key, result, nic);
      }
    }
  }

  // One more sample of a counter that only ever grows, applied in one step so that a Reset Stats
  // landing in the middle of a round cannot be undone by it, and so that FireMain cannot die
  // between storing the new raw sample and moving the total.
  //   KEYS[1] sys:ethInfo   KEYS[2] sys:ethInfo:raw
  //   ARGV[1] <nic>_<counter>   ARGV[2] the raw sample   ARGV[3] <nic>_stats_since
  async accumulate(key, raw, nic) {
    return rclient.evalAsync(accumulateLua, 2,
      Constants.REDIS_KEY_ETH_INFO, Constants.REDIS_KEY_ETH_INFO_RAW,
      key, raw, `${nic}_${ethCounters.STATS_SINCE_KEY}`);
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
        // collect() only reads the counters it takes off the NIC, a counter from another source
        // is not missing here, it was never looked for - updateCounter above keeps those
        if (!ethCounters.isCollected(metric))
          continue;
        if (!ethCounters.ETH_COUNTERS[metric].cumulative)
          continue;
        const key = `${nic}_${ethCounters.ETH_COUNTERS[metric].key}`;
        const result = counters[metric];
        // this one counter could not be read this round, which says nothing about whether the
        // driver has it, so leave the stored total alone exactly as for a NIC read that failed
        if (result === null)
          continue;
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
        await this.accumulate(key, result, nic);
      }
    }
  }
}

module.exports = NicStateSensor;
