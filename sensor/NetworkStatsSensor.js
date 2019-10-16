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

const fc = require('../net2/config.js');

const FEATURE_NETWORK_STATS = "network_stats";
const FEATURE_LINK_STATS = "link_stats";
const FEATURE_NETWORK_SPEED_TEST = "network_speed_test";

const rclient = require('../util/redis_manager.js').getRedisClient();

const Ping = require('../extension/ping/Ping.js');

const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager();

const util = require('util');
const exec = require('child-process-promise').exec;
const bone = require('../lib/Bone.js');
const speedtest = require('../extension/speedtest/speedtest.js');
const CronJob = require('cron').CronJob;

const _ = require('lodash');

class NetworkStatsSensor extends Sensor {
  async run() {
    this.processPingConfigure();
    if (fc.isFeatureOn(FEATURE_NETWORK_STATS)) {
      await this.turnOn();
    } else {
      await this.turnOff();
    }
    fc.onFeature(FEATURE_NETWORK_STATS, (feature, status) => {
      if (feature != FEATURE_NETWORK_STATS)
        return
      if (status) {
        this.turnOn();
      } else {
        this.turnOff();
      }
    })

    if (fc.isFeatureOn(FEATURE_NETWORK_SPEED_TEST)) {
      this.runSpeedTest();
    } else {
      this.stopSpeedTest();
    }
    fc.onFeature(FEATURE_NETWORK_SPEED_TEST, (feature, status) => {
      if (feature != FEATURE_NETWORK_SPEED_TEST)
        return
      if (status) {
        this.runSpeedTest();
      } else {
        this.stopSpeedTest();
      }
    })

    this.previousLog = new Set();
    this.checkNetworkStatus();
    setInterval(() => {
      this.checkNetworkStatus();
      if (!fc.isFeatureOn(FEATURE_LINK_STATS)) return;

      this.checkLinkStats();
    }, (this.config.interval || 300) * 1000);
  }
  processPingConfigure() {
    if (this.config.pingConfig) {
      Ping.configure(this.config.pingConfig);
    } else {
      Ping.configure();
    }
  }
  async turnOn() {
    this.pings = {};

    this.testGateway();
    this.testDNSServerPing();

    log.info("Feature is turned on.");
  }

  async turnOff() {
    if (this.pings) {
      for (const t in this.pings) {
        const p = this.pings[t];
        if (p) {
          p.stop();
          delete this.pings[t];
        }
      }
    }

    log.info("Feature is turned off.");
  }

  async apiRun() {

  }

  testPingPerf(type, target, redisKey) {
    if (this.pings[type]) {
      this.pings[type].stop();
      delete this.pings[type];
    }

    this.pings[type] = new Ping(sysManager.myGateway());
    this.pings[type].on('ping', (data) => {
      rclient.zadd(redisKey, Math.floor(new Date() / 1000), data.time);
    });
    this.pings[type].on('fail', () => {
      rclient.zadd(redisKey, Math.floor(new Date() / 1000), -1); // -1 as unreachable
    });
  }

  testGateway() {
    this.testPingPerf("gateway", sysManager.myGateway(), "perf:ping:gateway");
  }

  testDNSServerPing() {
    const dnses = sysManager.myDNS();
    if (!_.isEmpty(dnses)) {
      this.testPingPerf("dns", dnses[0], "perf:ping:dns");
    }
  }

  testDNSServerDNS() {

  }

  testFirewallaPing() {

  }

  async checkLinkStats() {
    log.info("checking link stats")
    try {
      // "|| true" prevents grep from yielding error when nothing matches
      const result = await exec('dmesg --time-format iso | grep -n "Link is Down" || true');
      const lines = result.stdout.split('\n');

      log.info(this.previousLog)
      log.info(lines)
      // there's always an empty string
      if (lines.length <= 1) return;

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        const numberAndTime = line.split(' ')[0].split(':');
        const lineNumber = numberAndTime[0];
        const lineTime = numberAndTime[1];

        if (this.previousLog.has(lineNumber)) {
          continue;
        } else {
          // log rotated
          if (i == 0) {
            this.previousLog.clear()
          }

          this.previousLog.add(lineNumber);

          await bone.logAsync("error",
            {
              type: 'FIREWALLA.NetworkStatsSensor.LinkDown',
              msg: { line }
            }
          );
        }

      }

    } catch (err) {
      log.error("Failed getting device log", err)
    }
  }

  async checkNetworkStatus() {
    const internetTestHosts = this.config.internetTestHosts;
    let dnses = sysManager.myDNS();
    const gateway = sysManager.myGateway();
    let servers = (this.config.dnsServers || []).concat(dnses);
    servers.push(gateway);
    let pings = {};
    for (const server of servers) {
      pings[server] = new Ping(server);
      pings[server].on('ping', (data) => {
        rclient.hsetAsync("network:status:ping", server, data.time);
      });
      pings[server].on('fail', (data) => {
        rclient.hsetAsync("network:status:ping", server, -1); // -1 as unreachable
      });
    }
    const { secondaryDnsServers, alternativeDnsServers } = JSON.parse(await rclient.hgetAsync("policy:system", "dnsmasq"))
    secondaryDnsServers && dnses.push(secondaryDnsServers)
    alternativeDnsServers && dnses.push(alternativeDnsServers)
    let resultGroupByHost = {};
    for (const internetTestHost of internetTestHosts) {
      const resultGroupByDns = {}
      for (const dns of dnses) {
        try {
          const result = await exec(`dig @${dns} +short ${internetTestHost}`);
          resultGroupByDns[dns] = {
            stdout: result.stdout ? result.stdout.split('\n').filter(x => x) : result.stdout,
            stderr: result.stderr ? result.stderr.split('\n').filter(x => x) : result.stderr
          }
        } catch (err) {
          resultGroupByDns[dns] = { err: err }
        }
      }
      resultGroupByHost[internetTestHost] = resultGroupByDns
    }
    rclient.setAsync("network:status:dig", JSON.stringify(resultGroupByHost));
  }
  async runSpeedTest() {
    this.cornJob && this.cornJob.stop();
    this.cornJob = new CronJob("00 30 02 * * *", () => {
      speedtest();
    }, null, true, await sysManager.getTimezone())
  }
  stopSpeedTest() {
    this.cornJob && this.cornJob.stop();
    this.cornJob = null;
  }
}

module.exports = NetworkStatsSensor;
