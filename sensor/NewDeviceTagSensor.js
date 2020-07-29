/*    Copyright 2020 Firewalla Inc
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

const log = require('../net2/logger.js')(__filename, 'info');
const { Sensor } = require('./Sensor.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const MessageBus = require('../net2/MessageBus.js');
const messageBus = new MessageBus('info')
const fc = require('../net2/config.js');

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();
const sysManager = require('../net2/SysManager.js')
const networkProfileManager = require('../net2/NetworkProfileManager.js')

// const PM2 = require('../alarm/PolicyManager2.js');
// const pm2 = new PM2();

const FEATURE_KEY = 'new_device_tag'

function copyPolicy(policy) {
  try {
    if (!policy) return {}
    return JSON.parse(JSON.stringify(policy))
  } catch(err) {
    log.error('Failed to parse policy', policy, err)
    return {}
  }
}

class NewDeviceTagSensor extends Sensor {

  constructor() {
    super()

    this.queue = []
    this.macIndex = {}
  }

  async checkAndExecutePolicy(channel, type, mac, host) {
    try {
      if (this.macIndex[mac])
        this.macIndex[mac] = false
      else
        return // already checked

      log.info('Checking new device', host)

      await hostManager.loadPolicyAsync()
      const systemPolicy = copyPolicy(hostManager.policy.newDeviceTag)
      systemPolicy.key = 'policy:system'
      log.debug(systemPolicy)

      const intf = sysManager.getInterfaceViaIP4(host.ipv4Addr)
      const networkProfile = networkProfileManager.getNetworkProfile(intf.uuid)
      const networkPolicy = copyPolicy((await networkProfile.loadPolicy()).newDeviceTag)
      networkPolicy.key = networkProfile._getPolicyKey()

      const policy = networkPolicy.state && networkPolicy || systemPolicy.state && systemPolicy || null

      log.debug(networkPolicy)
      if (!policy) return

      const hostObj = await hostManager.getHostAsync(host.mac)
      await hostObj.setPolicyAsync('tags', [ policy.tag ])

      log.info(`Added new device ${host.ipv4Addr} - ${host.mac} to group ${policy.tag} per ${policy.key}`)

    } catch(err) {
      log.error("Error adding new device", err)
    }
  }

  enqueueEvent(event) {
    this.queue.push(event)
  }

  run() {
    // ensure new devices found before IPTABLES_READY will be checked as well
    sem.on('NewDeviceFound', this.enqueueEvent)

    sem.once('IPTABLES_READY', () => {
      sem.on('NewDeviceFound', (event) => {
        if (!fc.isFeatureOn(FEATURE_KEY)) return

        this.macIndex[event.host.mac] = true
        // Use Device:Updated event as it's the time that host info will be written to redis
        messageBus.subscribeOnce("DiscoveryEvent", "Device:Updated", event.host.mac, this.checkAndExecutePolicy.bind(this))
      })

      sem.removeListener('NewDeviceFound', this.enqueueEvent)

      if (!fc.isFeatureOn(FEATURE_KEY)) return

      for (const event of this.queue) {
        this.macIndex[event.host.mac] = true
        messageBus.subscribeOnce("DiscoveryEvent", "Device:Updated", event.host.mac, this.checkAndExecutePolicy.bind(this))
      }
    })
  }

}

module.exports = NewDeviceTagSensor;
