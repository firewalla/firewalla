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

let bone = require("../lib/Bone.js");

let flowUtil = require("../net2/FlowUtil.js");

class NewDeviceHook extends Hook {

  createAlarm(name, ip, mac, vendor, callback) {
    callback = callback || function() {}

    let Alarm = require('../alarm/Alarm.js');
    let AM2 = require('../alarm/AlarmManager2.js');
    let am2 = new AM2();

    let alarm = new Alarm.NewDeviceAlarm(new Date() / 1000,
                                         name,
                                         {
                                           "p.device.id": name,
                                           "p.device.name": name,
                                           "p.device.ip": ip,
                                           "p.device.mac": mac,
                                           "p.device.vendor": vendor
                                         });

    am2.checkAndSave(alarm, (err) => {
      if(err) {
        log.error("Failed to save new alarm: " + err);
      }
      callback(err);
    });
  }

  getVendorInfo(mac, callback) {
    mac = mac.toUpperCase();
    let rawData = {
      ou: mac.slice(0,13), // use 0,13 for better OU compatibility
      uuid: flowUtil.hashMac(mac)
    }
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

  findMac(name, mac, retry) {

    retry = retry || 0;

    let Discovery = require("../net2/Discovery.js");
    let d = new Discovery("nmap", null, "info", false);
    
    // get ip address and mac vendor
    d.discoverMac(mac, (err, result) => {
      if(err) {
        log.error("Failed to discover mac address", mac, ": " + err, {});
        return;
      }

      if(!result) {
        // not found... kinda strange, hack??
        log.warn("New device " + name + " is not found in the network..");

        // if first time, try again in another 10 seconds
        if(retry === 0) {
          setTimeout(() => this.findMac(mac, retry + 1),
                     10 * 1000);
        }
        return;
      }

      log.info("Found a new device: " + name + "(" + mac + ")");

      result.name = name;
      result.nname = name;
      
      d.processHost(result, (err, host, newHost) => {
        // alarm will be handled and created by "NewDevice" event
        
      });
    });
  }
  
  run() {
    sem.on('NewDevice', (event) => {
      let mac = event.mac;
      let name = event.name;
      let ip = event.ipv4Addr;
      
      this.getVendorInfo(mac, (err, vendor) => {
        let v = "Unknown";
        if(err == null && vendor)
          v = vendor;
        this.createAlarm(name, ip, mac, v);
      });
    });
    
    sem.on('NewDeviceWithMacOnly', (event) => {

      let mac = event.mac;
      let name = event.name; // name should be fetched via DHCPDUMP

      let HostTool = require('../net2/HostTool')
      let hostTool = new HostTool();

      hostTool.macExists(mac)
        .then((result) => {
          if(result) {
            log.info("MAC Address", mac, " already exists, updating backup name");
            sem.emitEvent({
              type: "RefreshMacBackupName",
              message: "Update device backup name via MAC Address",
              mac:mac,
              name: name
            });
            return;
          }

          // delay discover, this is to ensure ip address is already allocated
          // to this new device
          setTimeout(() => {
            this.findMac(name, mac);
          }, 5000);
        });
    });

    sem.on('NewDeviceWithIPOnly', (event) => {
      let name = event.name;
      let ip = event.ipv4Addr;
      let ipv6s = event.ipv6s; // not used for now

      if(!name || !ip) {
        log.error("require name and ip for event NewDeviceWithIPOnly");
        return;
      }

      // get mac address
      let l2 = require('../util/Layer2.js');

      l2.getMAC(ip, (err, result) => {
        if(err) {
          log.error("Failed to discover device", ip, {});
          return;
        }
       
        if(!result || !result.mac_address) {
          // not found... kinda strange, hack??
          log.warn("New device " + name + " is not found in the network..");
          return;
        }

        if(result.mac_address) {
          // macVendor is optional
          this.createAlarm(name, ip, result.mac_address, result.macVendor);
        }
      });
    });
  }
}

module.exports = NewDeviceHook;
