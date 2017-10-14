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

let log = require('../net2/logger.js')(__filename, 'info');

let Hook = require('./Hook.js');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let HostTool = require('../net2/HostTool.js');
let hostTool = new HostTool();

let Promise = require('bluebird');

let extend = require('../util/util.js').extend;
let util = require('util');
let bone = require("../lib/Bone.js");

let flowUtil = require("../net2/FlowUtil.js");

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let Samba = require('../extension/samba/samba.js');
let samba = new Samba();

let HostManager = require('../net2/HostManager.js');

var _async = require('async');

const MAX_IPV6_ADDRESSES = 8

class DeviceHook extends Hook {
  constructor() {
    super();
  }

  deviceUpdateHook(event) {
    let host = event.host;
    let mac = host.mac;
    let ipv4Addr = host.ipv4Addr;

    hostTool.macExists(mac)
      .then((found) => {

        if(!found) {  // ==============> New Device Found

          sem.emitEvent({
            type: "NewDeviceFound",
            message: "A new device (mac address) found @ DeviceHook",
            host: host,
            suppressAlarm: event.suppressAlarm
          });

        } else {
          if (ipv4Addr) {
            hostTool.getIPv4Entry(ipv4Addr)
              .then((data) => {

                if(!data) {      // =========> This MAC Address has changed to new unrecorded IP Address

                  sem.emitEvent({
                    type: "OldDeviceChangedToNewIP",
                    message: "An old device used a new IP @ DeviceHook",
                    host: host
                  });
                  
                } else {
                  
                  if(mac !== data.mac) { // ========> This MAC Address has taken the IP Address used by another device
                    
                    sem.emitEvent({
                      type: "OldDeviceTakenOverOtherDeviceIP",
                      message: "An old device used IP used to be other device @ DeviceHook",
                      host: host,
                      oldMac: data.mac
                    });
                    
                  } else {  // =======> Regular Device Info Update
                    
                    sem.emitEvent({
                      type: "RegularDeviceInfoUpdate",
                      message: "Refresh device status @ DeviceHook",
                      suppressEventLogging: true,
                      host: host
                    });

                  }
                }
              }).catch((err) => {
                log.error("Failed to get host:ip4 entry:", err, {});
              })
          } else if (host.ipv6Addr) {
            sem.emitEvent({
              type: "IPv6DeviceInfoUpdate",
              message: "IPv6 Device Update @ DeviceHook",
              suppressEventLogging: true,
              host: host
            });
            
          }
        }
      }).catch((err) => {
        log.error("Failed to check if mac address exists:", err, {});
      });    
  }
  
  run() {

    // DeviceUpdate event format:
    //   ipv4: ipv4Addr
    //   ipv4Addr: ipv4Addr
    //   mac: mac
    //   bname: service.name (optional)
    //   ipv6Addr =  service.ipv6Addrs (optional)

    // DeviceUpdate may be triggered by nmap scan, bonjour monitor,
    // dhcp monitor and etc...

    sem.on("DeviceUpdate", (event) => {
      let mac = event.mac;

      this.deviceUpdateHook(event)
    });

    sem.on("IPv6DeviceInfoUpdate",(event)=>{
      let host = event.host;

      if (host.ipv6Addr && host.ipv6Addr.length>0) {
        log.info(util.format("A new IPv6DeviceInfoUpdate device %s - %s - %s is found!", host.ipv6Addr, host.mac));
        
        _async.eachLimit(host.ipv6Addr, 1, (v6, cb) => {
          hostTool.linkMacWithIPv6(v6,host.mac,cb);    
        }, (err) => {
        });
      }
    });

    sem.on("NewDeviceFound", (event) => {
      let host = event.host;

      log.info(util.format("A new device %s - %s - %s is found!", host.bname, host.ipv4Addr, host.mac));

      let enrichedHost = extend({}, host, {
        uid: host.ipv4Addr,
        firstFoundTimestamp: new Date() / 1000,
        lastActiveTimestamp: new Date() / 1000
      });

      async(() => {

        await (hostTool.updateHost(enrichedHost));

        log.info("Host entry is created for this new device");

        let mac = enrichedHost.mac;

        if(!mac)
          return; // ignore if mac is undefined

        let vendor = null;

        try {
          vendor = await (this.getVendorInfoAsync(mac));
        } catch(err) {
          // do nothing
          log.error("Failed to get vendor info from cloud", err, {});
        }

        let v = "Unknown";
        if(vendor)
          v = vendor;

        enrichedHost.macVendor = v;

        if(!enrichedHost.bname) {
          let sambaName = await (samba.getSambaName(host.ipv4Addr));
          if(sambaName)
            enrichedHost.bname = sambaName;
        }

        if(!enrichedHost.bname && enrichedHost.macVendor !== "Unknown") {
          // finally, use macVendor if no name
          // if macVendor is not available, don't set the bname
          enrichedHost.bname = enrichedHost.macVendor;
        }

        enrichedHost.bnameCheckTime = Math.floor(new Date() / 1000);

        await (hostTool.updateMACKey(enrichedHost));

        if(!event.suppressAlarm) {
          await (this.createAlarm(enrichedHost));
        } else {
          log.info("Alarm is suppressed for new device", hostTool.getHostname(enrichedHost), {})
        }

      })().catch((err) => {
        log.error("Failed to handle NewDeviceFound event:", err, {});
      });
    });

    sem.on("OldDeviceChangedToNewIP", (event) => {
      // FIXME: this is typically old ip is taken by some device else, not going to delete the old ip entry
      let host = event.host;

      log.info(util.format("Device %s (%s) has a new IP: %s", host.bname, host.mac, host.ipv4Addr));

      hostTool.getMACEntry(host.mac)
        .then((macData) => {
          let firstFoundTimestamp = macData.firstFoundTimestamp;
          if(!firstFoundTimestamp)
            firstFoundTimestamp = new Date() / 1000;

          let enrichedHost = extend({}, host, {
            uid: host.ipv4Addr,
            firstFoundTimestamp: firstFoundTimestamp,
            lastActiveTimestamp: new Date() / 1000
          });

          hostTool.updateHost(enrichedHost)
            .then(() => {
              log.info("New host entry is created for this new device");

              hostTool.updateMACKey(enrichedHost)
                .then(() => {

                  log.info("MAC entry is updated with new IP");

                  let hostManager= new HostManager("cli",'server','debug');
                  log.info(`Reload host info for new ip address ${host.ipv4Addr}`)
                  hostManager.getHost(host.ipv4Addr);

                }).catch((err) => {
                  log.error("Failed to create mac entry:", err, err.stack, {});
                })

            }).catch((err) => {
              log.error("Failed to create host entry:", err, {});
            });

        });

    });

    sem.on("OldDeviceTakenOverOtherDeviceIP", (event) => {
      let host = event.host;

      log.info(util.format("Device %s (%s) has a new IP: %s", host.bname, host.mac, host.ipv4Addr));

      hostTool.getMACEntry(host.mac)
        .then((macData) => {
          let firstFoundTimestamp = macData.firstFoundTimestamp;
          if(!firstFoundTimestamp)
            firstFoundTimestamp = new Date() / 1000;

          let enrichedHost = extend({}, host, {
            uid: host.ipv4Addr,
            firstFoundTimestamp: firstFoundTimestamp,
            lastActiveTimestamp: new Date() / 1000
          });

          hostTool.updateHost(enrichedHost)
            .then(() => {
              log.info("New host entry is created for this new device");

              hostTool.updateMACKey(enrichedHost)
                .then(() => {

                  log.info("MAC entry is updated with new IP");

                }).catch((err) => {
                  log.error("Failed to create mac entry:", err, err.stack, {});
                })

            }).catch((err) => {
              log.error("Failed to create host entry:", err, {});
            });

        });
    });

    sem.on("RegularDeviceInfoUpdate", (event) => {
      let host = event.host
      let mac = host.mac

      log.debug(util.format("Regular Device Update for %s (%s - %s)", host.bname, host.ipv4Addr, host.mac));

      let enrichedHost = extend({}, host, {
        lastActiveTimestamp: new Date() / 1000
      });

      async(() => {
        // For ipv6, need to load existing ip6 address from redis, and merge together
        // One device may have multiple ipv6 addresses
        if(enrichedHost.ipv6Addr) {
          let existingIPv6Addresses = await(hostTool.getIPv6AddressesByMAC(mac)) || []
          enrichedHost.ipv6Addr.forEach((addr) => {
            if(existingIPv6Addresses.indexOf(addr) === -1) {
              existingIPv6Addresses.push(addr) // found new ip address
              if(existingIPv6Addresses.length > MAX_IPV6_ADDRESSES) {
                existingIPv6Addresses.shift()
              }
            }
          })
          enrichedHost.ipv6Addr = existingIPv6Addresses
        }

        // FIXME: shoud not keep minimal info for host key, not all
        await (hostTool.updateHost(enrichedHost))   // host:ip4:.......

        await (hostTool.updateIPv6Host(enrichedHost)) // host:ip6:.........

        log.debug("Host entry is updated for this device");
        
        await (hostTool.updateMACKey(enrichedHost)) // host:mac:.....

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
        //       log.error("Failed to create mac entry:", err, err.stack, {});
        //     })

        // })        
      })().catch((err) => {
        log.error("Failed to create host entry:", err, err.stack, {});
      });
    
      
    });
  }

  createAlarmAsync(host) {
    return new Promise((resolve, reject) => {
      this.createAlarmAsync(host, (err) => {
        if(err) {
          reject(err);
        } else {
          resolve();
        }
      })
    })
  }

  createAlarm(host, callback) {
    callback = callback || function() {}

    let Alarm = require('../alarm/Alarm.js');
    let AM2 = require('../alarm/AlarmManager2.js');
    let am2 = new AM2();

    let name = host.bname || host.ipv4Addr;

    let alarm = new Alarm.NewDeviceAlarm(new Date() / 1000,
                                         name,
                                         {
                                           "p.device.id": name,
                                           "p.device.name": name,
                                           "p.device.ip": host.ipv4Addr,
                                           "p.device.mac": host.mac,
                                           "p.device.vendor": host.macVendor
                                         });

    am2.checkAndSave(alarm, (err) => {
      if(err) {
        log.error("Failed to save new alarm: " + err);
      }
      callback(err);
    });
  }

  getVendorInfoAsync(mac) {
    return new Promise((resolve, reject) => {
      this.getVendorInfo(mac, (err, vendorInfo) => {
        if(err) {
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
      ou: mac.slice(0,13), // use 0,13 for better OU compatibility
      uuid: flowUtil.hashMac(mac)
    };
    bone.device("identify", rawData, (err, enrichedData) => {
      if(err) {
        log.error("Failed to get vendor info for mac " + mac + ": " + err);
        callback(err);
        return;
      }

      if(enrichedData && enrichedData._vendor) {
        let v = enrichedData._vendor;
        if(v.startsWith('"'))
          v = v.slice(1); // workaround for buggy code, vendor has a unless prefix "
        callback(null, v);
      } else {
        callback(null, null);
      }
    });
  }


}

module.exports = DeviceHook;
