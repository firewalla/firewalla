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
const _ = require('lodash');
const Constants = require('../net2/Constants.js');
const TagManager = require('../net2/TagManager.js');
const delay = require('../util/util.js').delay;
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

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
        this.messageBus.unsubscribe("DiscoveryEvent", "Device:Create", mac, this.checkAndExecutePolicyBind)
        delete this.macIndex[mac]
      }
      else
        return // already checked

      const hostObj = await hostManager.getHostAsync(mac)
      if (!hostObj) {
        log.error('Host not found in HostManager', host)
        return
      }

      if (sysManager.isMyMac(mac)) {
        log.info('Skipping firewalla mac', host)
        return
      }

      log.info('Checking new device', host)

      await hostManager.loadPolicyAsync()
      const systemPolicy = copyPolicy(hostManager.policy.newDeviceTag)
      systemPolicy.key = 'policy:system'
      log.debug(systemPolicy)

      const intf = sysManager.getInterfaceViaUUID(hostObj.o.intf)
      let networkPolicy = {}
      if (!intf) {
        log.warn('Device without interface', mac)
      } else {
        if (hostObj.o.ipv4Addr && hostObj.o.ipv4Addr == intf.gateway ||
          hostObj.ipv6Addr && hostObj.ipv6Addr.includes(intf.gateway6)
        ) {
          log.info('Skipping gateway mac', host)
          return
        }

        const networkProfile = networkProfileManager.getNetworkProfile(intf.uuid)
        networkPolicy = copyPolicy(networkProfile.policy.newDeviceTag)
        networkPolicy.key = networkProfile._getPolicyKey()
      }

      let policy = networkPolicy.state && networkPolicy || systemPolicy.state && systemPolicy || null

      log.debug(networkPolicy)

      const isFWAP = this.isFirewallaAP(hostObj);
      let isQuarantine = 0

      if (!isFWAP && policy) {
        const ssidPSKTags = await TagManager.getPolicyTags("ssidPSK");  
        if (policy) {
          if (!_.isEmpty(ssidPSKTags))
            // there is ssid/PSK group mapping configured, hold for a while and see if the device is already assigned to another group.
            // SSID STA status is updated once every 2 seconds in fwapc in the first 10 minutes after a wireless STA is connected. So, 10 seconds should be enough.
            await delay(10000);
          const tags = await hostObj.getTags();
          if (!_.isEmpty(tags)) {
            log.warn(`Device ${mac} is already added to another group, new device tag will not be enforced`, tags);
            policy = null;
          } else {
            const tagCandidate = await hostTool.getWirelessDeviceTagCandidate(mac);
            if (!_.isEmpty(tagCandidate)) {
              if (tagCandidate !== "null") {
                log.warn(`Device ${mac} should be added to group ${tagCandidate}, new device tag will not be enforced`);
                policy = null;
                await hostObj.setPolicyAsync('tags', [tagCandidate]);
              }
              // delete cached tag uid candidate from redis immediately after it is used, in case the device is deleted and discovered as a new device again, new candidate will be regenerated
              await hostTool.deleteWirelessDeviceTagCandidate(mac);
            }
          }
          // check again and see if the new device needs to be put into quarantine group
          if (policy) {
            await hostObj.setPolicyAsync('tags', [policy.tag])
            log.info(`Added new device ${host.ipv4Addr} - ${host.mac} to group ${policy.tag} per ${policy.key}`)
            const tagExists = await TagManager.tagUidExists(policy.tag);
            if (tagExists) {
              isQuarantine = 1
            }
          }
        }
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
            "p.quarantine": isQuarantine
          });
        if (!isFWAP && policy && [policy.tag].map(String))
          alarm["p.tag.ids"] = [policy.tag].map(String);
        am2.enqueueAlarm(alarm);
      }
    } catch(err) {
      log.error("Error adding new device", err)
    }
  }

  enqueueEvent(event) {
    this.queue.push(event)
  }

  isFirewallaAP(hostObj) {
    const mac = _.get(hostObj, ["o", "mac"], "").toUpperCase();

    if (mac.startsWith(Constants.FW_AP_MAC_PREFIX) || mac.startsWith(Constants.FW_AP_CEILING_MAC_PREFIX))
      return true;
    
    return false;
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
        // HostManager.getHost is invoked at the same time in DeviceHook.js, so Host object is created
        // schedule task to write hosts file is delayed for 5sec and that's the time window here to
        // check policy and add tags
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
