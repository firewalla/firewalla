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

const extensionManager = require('./ExtensionManager.js')
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const fc = require('../net2/config.js');

const featureName = "network_stats";

const rclient = require('../util/redis_manager.js').getRedisClient();

const Ping = require('../extension/ping/Ping.js');

const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager();

const _ = require('lodash');

class NetworkStatsSensor extends Sensor {
  async run() {
    if (fc.isFeatureOn(featureName)) {
      await this.turnOn();
    } else {
      await this.turnOff();
    }
    fc.onFeature(featureName, (feature, status) => {
      if (feature != featureName)
        return

      if (status) {
        this.turnOn();
      } else {
        this.turnOff();
      }
    })
  }
  
  async turnOn() {
    if(this.config.pingConfig) {
      Ping.configure(this.config.pingConfig);
    } else {
      Ping.configure();
    }
    this.pings = {};
    
    this.testGateway();
    this.testDNSServerPing();

    log.info("Feature is turned on.");
  }

  async turnOff() {
    if(this.pings) {
      for(const t in this.pings) {
        const p = this.pings[t];
        if(p) {
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
    if(this.pings[type]) {
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
    if(!_.isEmpty(dnses)) {
      this.testPingPerf("dns", dnses[0], "perf:ping:dns");
    }
  }

  testDNSServerDNS() {
    
  }

  testFirewallaPing() {
    
  }
}

module.exports = NetworkStatsSensor;
