/*    Copyright 2020-2021 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient();

const mode = require('../net2/Mode.js')

const dhcp = require("../extension/dhcp/dhcp.js");

const sysManager = require('../net2/SysManager.js');

const redisKey = "sys:scan:dhcpserver";
class DHCPServerSensor extends Sensor {
  async run() {
    let firstScanTime = this.config.firstScan * 1000 || 120 * 1000; // default to 120 seconds
    setTimeout(() => {
      this.checkAndRunOnce();
    }, firstScanTime);

    let interval = this.config.interval * 1000 || 10 * 60 * 1000; // 10 minutes
    setInterval(() => {
      this.checkAndRunOnce();
    }, interval);
  }

  async checkAndRunOnce() {
    let serverStatus = false;
    await mode.reloadSetupMode();
    if (await mode.isRouterModeOn())
      return;
    let routerIP = sysManager.myDefaultGateway();
    if (routerIP) {
      serverStatus = await dhcp.dhcpServerStatus(routerIP);
    }
    await rclient.setAsync(redisKey, serverStatus);
    await rclient.expireAsync(redisKey, 86400);
  }
}

module.exports = DHCPServerSensor;
