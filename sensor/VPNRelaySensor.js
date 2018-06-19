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

const log = require('../net2/logger.js')(__filename)

const Sensor = require('./Sensor.js').Sensor

const sem = require('../sensor/SensorEventManager.js').getInstance()

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const rclient = require('../util/redis_manager.js').getRedisClient()

const Promise = require('bluebird')
const extensionManager = require('./ExtensionManager.js')

const fc = require('../net2/config.js')

const FRP = require('../extension/frp/frp.js')
const frp = new FRP()

const featureName = "vpn_relay"

const configKey = "ext.vpnRelayService"

const EncipherTool = require('../net2/EncipherTool.js')
const encipherTool = new EncipherTool()

class VPNRelaySensor extends Sensor {
  constructor() {
    super();
  }

  run() {
    async(() => {
      if(fc.isFeatureOn(featureName)) {
        await (this.turnOn())
      } else {
        await (this.turnOff())
      }
      fc.onFeature(featureName, (feature, status) => {
        if(feature != featureName)
          return

        if(status) {
          this.turnOn()
        } else {
          this.turnOff()
        }
      })
    })()
  }

  apiRun() {

    // register get/set handlers for fireapi

    extensionManager.onGet("vpnRelayService", (msg) => {
      return this.getRelayConfig()
    })

    extensionManager.onSet("vpnRelayService", (msg, data) => {
      return this.setRelayConfig(data)
    })
  }

  turnOn() {
    return async(() => {
      const config = await (this.getRelayConfig())
      config.internalPort = 1194 // api port
      config.name =  "vpn-" + await (encipherTool.getGID())
      config.protocol = "udp"


      const valid = this.validateConfig(config)
      if(valid) {
        const output = await (frp.createConfigFile("vpnRelay", config))
        if(output) {
          const filePath = output.filePath
          const port = output.port
          await (frp._start(filePath))
          if(!config.port && port) {
            await (rclient.hsetAsync(configKey, "port", port))
          }
        } else {
          return Promise.reject(new Error("Failed to create vpn relay config file"))
        }
      } else {
        return Promise.reject(new Error("Invalid VPN relay config"))
      }
    })()
  }

  turnOff() {
    return async(() => {
      frp._stop()
    })()
  }

  validateConfig(config) {
    // four key info
    // 1. server name => server
    // 2. server port => serverPort
    // 3. token => token
    return true
  }

  getRelayConfig() {
    return rclient.hgetallAsync(configKey)
  }

  setRelayConfig(data) {
    return async(() => {
      await(rclient.delAsync(configKey))
      return rclient.hmsetAsync(configKey, data)
    })()

  }
}

module.exports = VPNRelaySensor;
