/*    Copyright 2020-2023 Firewalla Inc.
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
const fc = require('../net2/config.js');

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();
const sysManager = require('../net2/SysManager.js')
const networkProfileManager = require('../net2/NetworkProfileManager.js')
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const { getPreferredBName } = require('../util/util.js')

const { Address6 } = require('ip-address')

// const PM2 = require('../alarm/PolicyManager2.js');
// const pm2 = new PM2();

const FEATURE_KEY = 'new_device_tag' // new_device_tag indicates whether new device quarantine is enabled
const ALARM_FEATURE_KEY = 'new_device' // new_device indicates whether new device alarm is enabled

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

  constructor(config) {
    super(config)

    // use dedicated instance as messageBus can't deal with multiple subscribers well
    this.messageBus = new MessageBus('info', 'newDeviceTag')
    this.queue = []
    this.macIndex = {}
  }

  async checkAndExecutePolicy(channel, type, mac, host) {
    try {
      if (this.macIndex[mac]) {
        // ip address is required to find the corresponding policy
        if (!host.ipv4Addr && !host.ipv6Addr) return

        if (!host.ipv4Addr && host.ipv6Addr) {
          const v6Addresses = host.ipv6Addr
            .map(str => new Address6(str))
            .filter(add6 => add6.isValid() && !add6.isLinkLocal())

          log.debug(v6Addresses)
          // only link local v6 address, ignore this event
          if (!v6Addresses.length) return

          host.realV6Address = v6Addresses
        }
        this.messageBus.unsubscribe("DiscoveryEvent", "Device:Create", mac, this.checkAndExecutePolicyBind)
        delete this.macIndex[mac]
      }
      else
        return // already checked

      if (sysManager.isMyMac(mac)) {
        log.info('Skipping firewalla mac', host)
        return
      }

      log.info('Checking new device', host)

      await hostManager.loadPolicyAsync()
      const systemPolicy = copyPolicy(hostManager.policy.newDeviceTag)
      systemPolicy.key = 'policy:system'
      log.debug(systemPolicy)

      const intf = sysManager.getInterfaceViaUUID(host.intf || host.intf_uuid) ||
                   host.ipv4Addr && sysManager.getInterfaceViaIP(host.ipv4Addr) ||
                   host.realV6Address && sysManager.getInterfaceViaIP(host.realV6Address[0].address)

      if (host.ipv4Addr && host.ipv4Addr == intf.gateway ||
          host.realV6Address && host.realV6Address.includes(intf.gateway6)
      ) {
        log.info('Skipping gateway mac', host)
        return
      }

      const networkProfile = networkProfileManager.getNetworkProfile(intf.uuid)
      const networkPolicy = copyPolicy((await networkProfile.loadPolicyAsync()).newDeviceTag)
      networkPolicy.key = networkProfile._getPolicyKey()

      const policy = networkPolicy.state && networkPolicy || systemPolicy.state && systemPolicy || null

      log.debug(networkPolicy)

      if (policy) {
        const hostObj = await hostManager.getHostAsync(host.mac)
        await hostObj.setPolicyAsync('tags', [ policy.tag ])

        log.info(`Added new device ${host.ipv4Addr} - ${host.mac} to group ${policy.tag} per ${policy.key}`)
      }
      if (fc.isFeatureOn(ALARM_FEATURE_KEY)) {
        const name = getPreferredBName(host) || "Unknown"
        const alarm = new Alarm.NewDeviceAlarm(new Date() / 1000,
          name,
          {
            "p.device.id": name,
            "p.device.name": name,
            "p.device.ip": host.ipv4Addr || host.ipv6Addr && host.ipv6Addr[0] || "",
            "p.device.mac": host.mac,
            "p.device.vendor": host.macVendor,
            "p.intf.id": host.intf ? host.intf : "",
            "p.tag.ids": policy && [ policy.tag ].map(String) || []
          });
        am2.enqueueAlarm(alarm);
      }
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

      this.checkAndExecutePolicyBind = this.checkAndExecutePolicy.bind(this)
      sem.on('NewDeviceFound', (event) => {
        if (!fc.isFeatureOn(FEATURE_KEY)) return

        this.macIndex[event.host.mac] = true

        // Use Device:Create event as it's the time that host info will be written to redis
        this.messageBus.subscribe(
          "DiscoveryEvent",
          "Device:Create",
          event.host.mac,
          this.checkAndExecutePolicyBind
        )
      })

      sem.removeListener('NewDeviceFound', this.enqueueEvent)

      if (!fc.isFeatureOn(FEATURE_KEY)) return

      for (const event of this.queue) {
        this.macIndex[event.host.mac] = true
      }
    })
  }

}

module.exports = NewDeviceTagSensor;
