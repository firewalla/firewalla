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

const Ping = require('../extension/ping/Ping.js');
Ping.configure();

const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager();

class NetworkStatsSensor extends Sensor {
  async run() {
    this.testGateway();
  }

  async apiRun() {

  }

  async testGateway() {
    const ping = new Ping(sysManager.myGateway());
    ping.on('ping', (data) => {
      log.info('Ping %s: time: %d ms', data.host, data.time);
    });
    ping.on('fail', (data) => {
      log.info('fail', data);
    });
  } 
}

module.exports = NetworkStatsSensor;
