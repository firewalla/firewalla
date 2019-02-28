/*    Copyright 2019 Firewalla LLC
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

const extensionManager = require('./ExtensionManager.js')

const f = require('../net2/Firewalla.js');

const config = require('../net2/config.js').getConfig();

const UPNP = require('../extension/upnp/upnp.js');
const upnp = new UPNP();

const iptool = require('ip');

const rclient = require('../util/redis_manager.js').getRedisClient();

const api = config.firewallaVPNCheckURL || "https://api.firewalla.com/diag/api/v1/vpn/check_portmapping";

const expireTime = 35 * 60;
const checkTime = 60 * 15;

class DoubleNatPlugin extends Sensor {

  async run() {
    this.job();
    setTimeout(() => {
      this.job().catch((err) => undefined );
    }, 1000 * checkTime); // every 15 minutes
  }

  async job() {
    const ip = await upnp.getExternalIP();
    if(ip) {
      const key = "ext.external.ip";
      await rclient.setAsync(key, ip);
      await rclient.expireAsync(key, expireTime);

      const key2 = "ext.doublenat";
      if(iptool.isPrivate(ip)) {
        await rclient.setAsync(key2, 1);
      } else {
        await rclient.setAsync(key2, 0);
      }
      await rclient.expireAsync(key2, expireTime);

    }
  }
}

module.exports = DoubleNatPlugin
