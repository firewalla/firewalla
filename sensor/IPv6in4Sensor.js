/*    Copyright 2016-2021 Firewalla Inc.
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

const IPV6In4 = require('../extension/ipv6in4/ipv6in4.js')
const ipv6 = new IPV6In4()

const updateInterval = 3600 * 1000 // once per hour

class IPv6in4Sensor extends Sensor {

  scheduledJob() {
    if(ipv6.hasConfig() &&
       ipv6.config.updatePublicIP) {
      ipv6.updatePublicIP()
    }
  }

  run() {
    extensionManager.registerExtension("ipv6in4", this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop,
      setConfig: ipv6.setConfig,
      getConfig: ipv6.loadConfig
    })
  }

  applyPolicy(host, ip, policy) {
    if(ip !== "0.0.0.0") {
      return;
    }

    log.info("Applying policy:", policy);
    if(policy === true) {
      return this.start()
    } else {
      return this.stop()
    }
  }

  async start() {
    await ipv6.start()

    process.nextTick(() => {
      this.scheduledJob()
    })

    this.timer = setInterval(() => {
      this.scheduledJob();
    }, updateInterval);
  }

  async stop() {
    await ipv6.stop()
    clearTimeout(this.timer)
    this.timer = null
  }
}

module.exports = IPv6in4Sensor
