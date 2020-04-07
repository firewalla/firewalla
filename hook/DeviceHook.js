/*    Copyright 2016-2020 Firewalla Inc.
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
const _ = require('lodash');

const log = require('../net2/logger.js')(__filename, 'info');

const Hook = require('./Hook.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const Promise = require('bluebird');

const extend = require('../util/util.js').extend;
const util = require('util');
const bone = require("../lib/Bone.js");

const flowUtil = require("../net2/FlowUtil.js");

const fc = require('../net2/config.js')

const Samba = require('../extension/samba/samba.js');
const samba = new Samba();
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();


const HostManager = require('../net2/HostManager.js');

const sysManager = require('../net2/SysManager.js');

const l2 = require('../util/Layer2.js');

const MAX_IPV6_ADDRESSES = 10
const MAX_LINKLOCAL_IPV6_ADDRESSES = 3
const MessageBus = require('../net2/MessageBus.js');

class DeviceHook extends Hook {
  constructor() {
    super();
    this.messageBus = new MessageBus('info');
  }

  async processDeviceUpdate(event) {
    let host = event.host
    let mac = host.mac
    let ipv4Addr = host.ipv4Addr
    let ipv6Addr = host.ipv6Addr

    if (!mac) { // ignore if no mac
      log.info("Invalid MAC address for process device update:", event);
      return;
    }

    mac = mac.toUpperCase()
    host.mac = mac // make sure the MAC is upper case

    try {

      // 0. update a special name key for source
      if (host.from) {
        let skey = `${host.from}Name`
        host[skey] = host.bname
        host.lastFrom = host.from
        delete host.from
      }

      // 1. if this is a brand new mac address => NewDeviceFound
      let found = await hostTool.macExists(mac)
      if (!found) {
        log.info(`A new device is found: '${mac}' `)
        sem.emitEvent({
          type: "NewDeviceFound",
          message: "A new device (mac address) found @ DeviceHook",
          host: host,
          suppressAlarm: event.suppressAlarm
        })
        return
      }

      // 2. if this is an existing mac address, and it has same ipv4 address => RegularDeviceInfoUpdate
      // it may update redis ip6 keys if additional ip addresses are added
      if (ipv4Addr) {
        let ip4Entry = await hostTool.getIPv4Entry(ipv4Addr)
        if (ip4Entry && ip4Entry.mac === mac) {
          sem.emitEvent({
            type: "RegularDeviceInfoUpdate",
            message: "Refresh device status @ DeviceHook",
            suppressEventLogging: true,
            suppressAlarm: event.suppressAlarm,
            host: host
          });
          return
        }

        // 3. if this is an existing mac address, and it has a different ipv4 address, (the ipv4 is owned by nobody in redis) => OldDeviceChangedToNewIP
        // it may update redis ip6 keys if additional ip addresses are added
        if (!ip4Entry) {
          sem.emitEvent({
            type: "OldDeviceChangedToNewIP",
            message: "An old device used a new IP @ DeviceHook",
            suppressAlarm: event.suppressAlarm,
            host: host
          })
          return
        }

        // 4. if this is an existing mac address, and it has a different ipv4 address, (the ipv4 is already owned by someone in redis) => OldDeviceTakenOverOtherDeviceIP
        // it may update redis ip6 keys if additional ip addresses are added
        if (ip4Entry && ip4Entry.mac !== mac) {
          sem.emitEvent({
            type: "OldDeviceTakenOverOtherDeviceIP",
            message: "An old device used IP used to be other device @ DeviceHook",
            suppressAlarm: event.suppressAlarm,
            host: host,
            oldMac: ip4Entry.mac
          })
          return
        }

      } else {
        // 5. if this is an existing mac address, and it has no ipv4 address (only ipv6 addresses)

        // Then just update the ipv6 entries
        if (ipv6Addr) {
          await hostTool.updateIPv6Host(host, ipv6Addr) // v6
          let newIPv6Addr = await this.updateIPv6EntriesForMAC(ipv6Addr, mac)
          let newHost = extend({}, host, { ipv6Addr: newIPv6Addr })

          log.debug("DeviceHook:IPv6Update:", JSON.stringify(newIPv6Addr));
          await hostTool.updateMACKey(newHost) // mac
        }
      }

    } catch (err) {
      log.error("Failed to process DeviceUpdate event:", err);
    }
  }

  run() {
    sem.once('IPTABLES_READY', () => {
      // DeviceUpdate event format:
      //   ipv4: ipv4Addr
      //   ipv4Addr: ipv4Addr
      //   mac: mac
      //   bname: service.name (optional)
      //   ipv6Addr =  service.ipv6Addrs (optional)

      // DeviceUpdate may be triggered by nmap scan, bonjour monitor,
      // dhcp monitor and etc...
      sem.on("DeviceUpdate", (event) => {
        let host = event.host
        let mac = host.mac;
        let ip = host.ipv4 || host.ipv4Addr;
        host.ipv4 = ip;
        host.ipv4Addr = ip;
        if (_.isString(host.ipv4)) {
          const intfInfo = sysManager.getInterfaceViaIP4(host.ipv4);
  
          if (intfInfo && intfInfo.uuid) {
            let intf = intfInfo.uuid;
            delete host.intf_mac;
            host.intf = intf;
          } else {
            log.error(`Unable to find nif uuid, ${host.ipv4}`);
          }
        }
  
        if (mac != null) {
          this.processDeviceUpdate(event);
        } else {
          let ip = host.ipv4 || host.ipv4Addr
          if (ip) {
            // need to get mac address first
            (async () => {
              let theMac = await l2.getMACAsync(ip)
              host.mac = theMac
              this.processDeviceUpdate(event)
            })().catch((err) => {
              log.error(`Failed to get mac address for ip ${ip}`, err)
            })
          }
        }
  
      });
  
      sem.on("IPv6DeviceInfoUpdate", async (event) => {
        let host = event.host;
  
  
        if (host.ipv6Addr && host.ipv6Addr.length > 0) {
          log.info(`A new IPv6DeviceInfoUpdate device ${host.ipv6Addr} - ${host.mac} is found!`);
  
          for (const v6 of host.ipv6Addr) {
            await hostTool.linkMacWithIPv6(v6, host.mac)
              .catch(log.error)
          }
          this.messageBus.publish("DiscoveryEvent", "Device:Updated", host.mac, host);
        }
      });
  
      sem.on("NewDeviceFound", (event) => {
        let host = event.host;
  
        log.info(util.format("A new device %s - %s - %s is found!", host.bname, host.ipv4Addr, host.mac));
  
        let enrichedHost = extend({}, host, {
          uid: host.ipv4Addr || this.getFirstIPv6(host) || host.mac || "Unknown",
          firstFoundTimestamp: new Date() / 1000,
          lastActiveTimestamp: new Date() / 1000
        });
  
        (async () => {
  
          // v4
          if (enrichedHost.ipv4Addr) {
            let previousEntry = await hostTool.getIPv4Entry(enrichedHost.ipv4Addr)
            if (previousEntry && enrichedHost.ipv4Addr === sysManager.myGateway()) {
              // gateway ip entry is previously recorded and now its ip address is taken over, handle it separately
              log.info("Suspected spoofing device detected: " + enrichedHost.mac);
              this.createAlarm(enrichedHost, 'spoofing_device');
            }
            await hostTool.updateIPv4Host(enrichedHost);
          }
  
          // v6
          if (enrichedHost.ipv6Addr)
            await hostTool.updateIPv6Host(enrichedHost, enrichedHost.ipv6Addr);
  
          log.info("Host entry is created for this new device:", host);
  
          let mac = enrichedHost.mac;
  
          if (!mac)
            return; // ignore if mac is undefined
  
          let vendor = null;
  
          try {
            vendor = await this.getVendorInfoAsync(mac);
          } catch (err) {
            // do nothing
            log.error("Failed to get vendor info from cloud", err);
          }
  
          let v = vendor || host.macVendor || "Unknown";
  
          enrichedHost.macVendor = v;
  
          if (!enrichedHost.bname && host.ipv4Addr) {
            let sambaName = await samba.getSambaName(host.ipv4Addr);
            if (sambaName)
              enrichedHost.bname = sambaName;
          }
  
          if (!enrichedHost.bname && enrichedHost.macVendor !== "Unknown") {
            // finally, use macVendor if no name
            // if macVendor is not available, don't set the bname
            enrichedHost.bname = enrichedHost.macVendor;
          }
  
          enrichedHost.bnameCheckTime = Math.floor(new Date() / 1000);
  
          await hostTool.updateMACKey(enrichedHost);
  
          if (!event.suppressAlarm) {
            this.createAlarm(enrichedHost);
          } else {
            log.info("Alarm is suppressed for new device", hostTool.getHostname(enrichedHost));
          }
          const hostManager = new HostManager();
          hostManager.getHost(host.mac, (err, host) => {
            // directly start spoofing
            if (err) {
              log.error("Failed to get host after it is detected.");
            }
            if (!sysManager.isMyIP(host.ipv4Addr) && host.ipv4Addr !== sysManager.myWifiIp()) {
              host.spoof(true);
            }
          });
          this.setupLocalDeviceDomain(host.mac, 'new_device');
  
          this.messageBus.publish("DiscoveryEvent", "Device:Updated", host.mac, enrichedHost);
        })().catch((err) => {
          log.error("Failed to handle NewDeviceFound event:", err);
        });
      });
  
      sem.on("OldDeviceChangedToNewIP", (event) => {
        // FIXME: this is typically old ip is taken by some device else, not going to delete the old ip entry
        let host = event.host;
  
        log.info(util.format("Device %s (%s) has a new IP: %s", host.bname, host.mac, host.ipv4Addr));
  
        (async () => {
          let macData = await hostTool.getMACEntry(host.mac);
          let currentTimestamp = new Date() / 1000;
  
          let firstFoundTimestamp = macData.firstFoundTimestamp;
          let lastActiveTimestamp = macData.lastActiveTimestamp;
          if (!firstFoundTimestamp)
            firstFoundTimestamp = currentTimestamp;
  
          let enrichedHost = extend({}, host, {
            uid: host.ipv4Addr,
            firstFoundTimestamp: firstFoundTimestamp,
            lastActiveTimestamp: currentTimestamp
          });
  
          await hostTool.updateIPv4Host(enrichedHost); // update host:ip4:xxx entries
          if (enrichedHost.ipv6Addr)
            await hostTool.updateIPv6Host(enrichedHost, enrichedHost.ipv6Addr); // update host:ip6:xxx entries
  
          log.info("New host entry is created for this old device");
  
          if (enrichedHost.ipv6Addr) {
            enrichedHost.ipv6Addr = await this.updateIPv6EntriesForMAC(enrichedHost.ipv6Addr, host.mac);
          }
  
          if (!lastActiveTimestamp || lastActiveTimestamp < currentTimestamp - this.config.hostExpirationSecs) {
            // Become active again after a while, create a DeviceBackOnlineAlarm
            log.info("Device is back on line, mac: " + host.mac + ", ip: " + host.ipv4Addr);
            if (!event.suppressAlarm) {
              try {
                const enabled = await this.isFeatureEnabled(host.mac, "devicePresence");
                if (enabled) {
                  this.createAlarm(enrichedHost, 'device_online');
                } else {
                  log.info("Device presence is disabled for " + host.mac);
                }
              } catch (err) {
                log.error("Failed to load device presence settings", err);
              }
            }
          }
  
          await hostTool.updateMACKey(enrichedHost); // mac
  
  
          log.info("MAC entry is updated with new IP");
  
          log.info(`Reload host info for new ip address ${host.ipv4Addr}`)
          let hostManager = new HostManager()
          hostManager.getHost(host.mac);
          this.setupLocalDeviceDomain(host.mac, 'ip_change');
  
          this.messageBus.publish("DiscoveryEvent", "Device:Updated", host.mac, enrichedHost);
        })().catch((err) => {
          log.error("Failed to process OldDeviceChangedToNewIP event:", err);
        })
      });
  
      sem.on("OldDeviceTakenOverOtherDeviceIP", (event) => {
        let host = event.host;
  
        log.info(util.format("Device %s (%s) has a new IP: %s", host.bname, host.mac, host.ipv4Addr));
  
        (async () => {
          let macData = await hostTool.getMACEntry(host.mac);
          let currentTimestamp = new Date() / 1000;
  
          let firstFoundTimestamp = macData.firstFoundTimestamp;
          let lastActiveTimestamp = macData.lastActiveTimestamp;
          if (!firstFoundTimestamp)
            firstFoundTimestamp = currentTimestamp;
  
          let enrichedHost = extend({}, host, {
            uid: host.ipv4Addr,
            firstFoundTimestamp: firstFoundTimestamp,
            lastActiveTimestamp: currentTimestamp
          });
  
          if (enrichedHost.ipv4Addr === sysManager.myGateway()) {
            // ip address of gateway is taken over, handle it separately
            log.info("Suspected spoofing device detected: " + enrichedHost.mac);
            this.createAlarm(enrichedHost, 'spoofing_device');
          }
  
          await hostTool.updateIPv4Host(enrichedHost);
          if (enrichedHost.ipv6Addr)
            await hostTool.updateIPv6Host(enrichedHost, enrichedHost.ipv6Addr); // update host:ip6:xxx entries
  
          if (enrichedHost.ipv6Addr) {
            enrichedHost.ipv6Addr = await this.updateIPv6EntriesForMAC(enrichedHost.ipv6Addr, host.mac);
          }
  
          if (!lastActiveTimestamp || lastActiveTimestamp < currentTimestamp - this.config.hostExpirationSecs) {
            // Become active again after a while, create a DeviceBackOnlineAlarm
            log.info("Device is back on line, mac: " + host.mac + ", ip: " + host.ipv4Addr);
            if (!event.suppressAlarm) {
              try {
                const enabled = await this.isFeatureEnabled(host.mac, "devicePresence");
                if (enabled) {
                  this.createAlarm(enrichedHost, 'device_online');
                } else {
                  log.info("Device presence is disabled for " + host.mac);
                }
              } catch (err) {
                log.error("Failed to load device presence settings", err);
              }
            }
          }
  
          await hostTool.updateMACKey(enrichedHost);
  
          // Fix to firewalla/firewalla.ios#991
          //
          // This might cause one device disappear from app as the flow/host list on app is
          // generated by mac->ip->device mapping. It will come back later once discovered again
          //
          // Another issue in this scenario is that this could mess up flow-device mappings
          // which could only be fix once flow is associated with mac address
          await hostTool.removeDupIPv4FromMacEntry(event.oldMac, host.ipv4Addr, host.mac);
  
          log.info("MAC entry is updated with new IP");
  
          log.info(`Reload host info for new ip address ${host.ipv4Addr}`);
          let hostManager = new HostManager();
          hostManager.getHost(host.mac);
          this.setupLocalDeviceDomain(host.mac, 'ip_change');
  
          this.messageBus.publish("DiscoveryEvent", "Device:Updated", host.mac, enrichedHost);
        })().catch((err) => {
          log.error("Failed to process OldDeviceTakenOverOtherDeviceIP event:", err);
        })
      });
  
      sem.on("RegularDeviceInfoUpdate", (event) => {
        let host = event.host
        let mac = host.mac
  
        log.debug(util.format("Regular Device Update for %s (%s - %s)", host.bname, host.ipv4Addr, host.mac));
  
        let currentTimestamp = new Date() / 1000;
        let enrichedHost = extend({}, host, {
          uid: host.ipv4Addr,
          lastActiveTimestamp: currentTimestamp
        });
  
        (async () => {
          // For ipv6, need to load existing ip6 address from redis, and merge together
          // One device may have multiple ipv6 addresses
          let macData = await hostTool.getMACEntry(host.mac);
          let lastActiveTimestamp = macData.lastActiveTimestamp;
  
          // FIXME: shoud not keep minimal info for host key, not all
          await hostTool.updateIPv4Host(enrichedHost);   // update host:ip4:xxx entries
          if (enrichedHost.ipv6Addr)
            await hostTool.updateIPv6Host(enrichedHost, enrichedHost.ipv6Addr); // update host:ip6:xxx entries
  
          if (enrichedHost.ipv6Addr) {
            enrichedHost.ipv6Addr = await this.updateIPv6EntriesForMAC(enrichedHost.ipv6Addr, mac);
          }
  
          log.debug("Host entry is updated for this device");
  
          if (!lastActiveTimestamp || lastActiveTimestamp < currentTimestamp - this.config.hostExpirationSecs) {
            // Become active again after a while, create a DeviceBackOnlineAlarm
            log.info("Device is back on line, mac: " + host.mac + ", ip: " + host.ipv4Addr);
            if (!event.suppressAlarm) {
              try {
                const enabled = await this.isFeatureEnabled(host.mac, "devicePresence");
                if (enabled) {
                  this.createAlarm(enrichedHost, 'device_online');
                } else {
                  log.info("Device presence is disabled for " + host.mac);
                }
              } catch (err) {
                log.error("Failed to load device presence settings", err);
              }
            }
          }
  
          await hostTool.updateMACKey(enrichedHost); // host:mac:.....
          // publish device updated event to trigger 
          this.messageBus.publish("DiscoveryEvent", "Device:Updated", host.mac, enrichedHost);
          this.setupLocalDeviceDomain(host.mac, 'info_change');
          // log.info("RegularDeviceInfoUpdate MAC entry is updated, checking V6",host.ipv6Addr,enrichedHost.ipv6Addr);
          // if (host.ipv6Addr == null || host.ipv6Addr.length == 0) {
          //         return;
          //       }
          // if (host.ipv6Addr.length == enrichedHost.ipv6Addr.length
          //     && host.ipv6Addr.every(function(u, i) {
          //             return u === enrichedHost.ipv6Addr[i];
          //           })
          //          ) {
          //       } else {
          //         sem.emitEvent({
          //           type: "IPv6DeviceInfoUpdate",
          //           message: "IPv6 Device Update @ DeviceHook",
          //           suppressEventLogging: true,
          //           host: host
          //         });
          //       }
          //     }).catch((err) => {
          //       log.error("Failed to create mac entry:", err, err.stack);
          //     })
  
          // })
        })().catch((err) => {
          log.error("Failed to create host entry:", err, err.stack);
        });
  
  
      });
  
      sem.on("DeviceOffline", (event) => {
        const host = event.host;
        (async () => {
          try {
            // device back online and offline both abide by device presence settings
            const enabled = await this.isFeatureEnabled(host.mac, "deviceOffline");
            if (enabled) {
              this.createAlarm(host, 'device_offline');
            } else {
              log.info("Device presence is disabled for " + host.mac);
            }
          } catch (err) {
            log.error("Failed to load device presence settings", err);
          }
        })().catch((err) => {
          log.error("Failed to process DeviceOffline event:", err);
        });
      });
    });
  }

  /*
   * ipv6 address fields works like a queue.  oldest discovered ipv6 address
   * at index 0.  any newly discovered ip must be placed at the end by taking
   * out from its old possition
   */
  async updateIPv6EntriesForMAC(ipv6Addr, mac) {
    let existingIPv6Addresses = await hostTool.getIPv6AddressesByMAC(mac) || []
    let linklocalAddrs = [];
    let globalAddrs = [];

    existingIPv6Addresses.forEach((addr) => {
      if (addr.startsWith("fe80")) {
        linklocalAddrs.push(addr);
      } else {
        globalAddrs.push(addr);
      }
    });

    ipv6Addr.forEach((addr) => {
      let addrList = globalAddrs;
      let max = MAX_IPV6_ADDRESSES;
      if (addr.startsWith("fe80")) {
        addrList = linklocalAddrs;
        max = MAX_LINKLOCAL_IPV6_ADDRESSES;
      }
      let index = addrList.indexOf(addr);
      if (index > -1) {
        addrList.splice(index, 1);
      }
      addrList.push(addr) // found new ip address
      if (addrList.length > max) {
        let removed = addrList.shift()
        //      log.info("DEVICEHOOK_DEBUG_REMOVEV6",removed);
      }
    })

    //  log.info("DEVICEHOOK",ipv6Addr, linklocalAddrs, globalAddrs);

    return linklocalAddrs.concat(globalAddrs);
  }

  createAlarmAsync(host, type) {
    return new Promise((resolve, reject) => {
      this.createAlarm(host, type);
      resolve();
    })
  }

  getFirstIPv6(host) {
    return host.ipv6Addr && host.ipv6Addr.length > 0 && host.ipv6Addr[0]
  }

  getPreferredName(host) {
    return host.bname || host.ipv4Addr || this.getFirstIPv6(host) || "Unknown"
  }

  async isFeatureEnabled(mac, feature) {
    const policy = await hostTool.loadDevicePolicyByMAC(mac);
    if (policy && policy[feature] === "true") {
      return true;
    }
    return false; // by default return false, a conservative fallback
  }

  createAlarm(host, type) {
    type = type || "new_device";

    // check if new device alarm is enabled or not
    if (!fc.isFeatureOn(type)) {
      return
    }

    let Alarm = require('../alarm/Alarm.js');
    let AM2 = require('../alarm/AlarmManager2.js');
    let am2 = new AM2();

    let name = this.getPreferredName(host)
    let tags = [];
    const hostManager = new HostManager();
    const hostInstance = hostManager.getHostFastByMAC(host.mac);
    if (hostInstance) {
      tags = hostInstance.getTags();
    }

    let alarm = null;
    switch (type) {
      case "new_device":
        // no new device alarm on Firewalla
        if (sysManager.isMyMac(host.mac)) {
          log.info('New device alarm on Firewalla', host)
          return
        }

        alarm = new Alarm.NewDeviceAlarm(new Date() / 1000,
          name,
          {
            "p.device.id": name,
            "p.device.name": name,
            "p.device.ip": host.ipv4Addr || this.getFirstIPv6(host),
            "p.device.mac": host.mac,
            "p.device.vendor": host.macVendor,
            "p.intf.id": host.intf ? host.intf : "",
            "p.tag.ids": tags
          });
        am2.enqueueAlarm(alarm);
        break;
      case "device_online":
        alarm = new Alarm.DeviceBackOnlineAlarm(new Date() / 1000,
          name,
          {
            "p.device.id": name,
            "p.device.name": name,
            "p.device.ip": host.ipv4Addr || this.getFirstIPv6(host),
            "p.device.mac": host.mac,
            "p.device.vendor": host.macVendor,
            "p.intf.id": host.intf ? host.intf : "",
            "p.tag.ids": tags
          });
        am2.enqueueAlarm(alarm);
        break;
      case "device_offline":
        alarm = new Alarm.DeviceOfflineAlarm(new Date() / 1000,
          name,
          {
            "p.device.id": name,
            "p.device.name": name,
            "p.device.ip": host.ipv4Addr || this.getFirstIPv6(host),
            "p.device.mac": host.mac,
            "p.device.vendor": host.macVendor,
            "p.device.lastSeen": host.lastActiveTimestamp,
            "p.intf.id": host.intf ? host.intf : "",
            "p.tag.ids": tags
          });
        am2.enqueueAlarm(alarm);
        break;
      case "spoofing_device":
        alarm = new Alarm.SpoofingDeviceAlarm(new Date() / 1000,
          name,
          {
            "p.device.id": name,
            "p.device.name": name,
            "p.device.ip": host.ipv4Addr || this.getFirstIPv6(host),
            "p.device.mac": host.mac,
            "p.device.vendor": host.macVendor,
            "p.intf.id": host.intf ? host.intf : "",
            "p.tag.ids": tags
          });
        am2.enqueueAlarm(alarm);
        break;
      default:
        log.error("Unsupported alarm type: ", type);
    }
  }

  getVendorInfoAsync(mac) {
    return new Promise((resolve, reject) => {
      this.getVendorInfo(mac, (err, vendorInfo) => {
        if (err) {
          reject(err);
        } else {
          resolve(vendorInfo);
        }
      })
    })
  }

  getVendorInfo(mac, callback) {
    mac = mac.toUpperCase();
    let rawData = {
      ou: mac.slice(0, 13), // use 0,13 for better OU compatibility
      uuid: flowUtil.hashMac(mac)
    };
    bone.device("identify", rawData, (err, enrichedData) => {
      if (err) {
        log.error("Failed to get vendor info for mac " + mac + ": " + err);
        callback(err);
        return;
      }

      if (enrichedData && enrichedData._vendor) {
        let v = enrichedData._vendor;
        if (v.startsWith('"'))
          v = v.slice(1); // workaround for buggy code, vendor has a unless prefix "
        callback(null, v);
      } else {
        callback(null, null);
      }
    });
  }
  async setupLocalDeviceDomain(mac, type) {
    if (!mac) return;
    if (type == 'new_device' || type == 'info_change') {
      await hostTool.generateLocalDomain(mac);
    }
    await dnsmasq.setupLocalDeviceDomain([mac]);
  }


}

module.exports = DeviceHook;
