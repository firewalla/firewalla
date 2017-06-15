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
  
  init() {
    sem.on('NewDevice', (event) => {
      this.createAlarm(event.name, event.ipv4Addr, event.mac, event.macVendor);
    });
    
    sem.on('NewDeviceWithMacOnly', (event) => {
      let Discovery = require("../net2/Discovery.js");
      let d = new Discovery("nmap", null, "info");

      let mac = event.mac;
      let name = event.name; // name should be fetched via DHCPDUMP

      // delay discover, this is to ensure ip address is already allocated
      // to this new device
      setTimeout(() => {
        // get ip address and mac vendor
        d.discoverMac(mac, (err, result) => {
          if(err) {
            log.error("Failed to discover mac address", mac, ": " + err, {});
            return;
          }

          if(!result) {
            // not found... kinda strange, hack??
            log.warn("New device " + name + " is not found in the network..");
            return;
          }

          log.info("Found a new device: " + name + "(" + mac + ")");

          result.name = name;
          result.nname = name;
          
          d.processHost(result, (err, host, newHost) => {
            // alarm will be handled and created by "NewDevice" event
          });
        });
      }, 5000);
    });

    sem.on('NewDeviceWithIPOnly', (event) => {
      let name = event.name;
      let ip = event.ipv4Addr;

      if(!name || !ip) {
        log.error("require name and ip for event NewDeviceWithIPOnly");
        return;
      }

      let Discovery = require("../net2/Discovery.js");
      let d = new Discovery("nmap", null, "info");

      // get mac address
      d.discoverIP(ip, (err, result) => {
        if(err) {
          log.error("Failed to discover device", ip, {});
          return;
        }

       
        if(!result) {
          // not found... kinda strange, hack??
          log.warn("New device " + name + " is not found in the network..");
          return;
        }

        if(result.mac) {
          // macVendor is optional
          this.createAlarm(name, ip, result.mac, result.macVendor);
        }
      });
    });
  }
}

module.exports = NewDeviceHook;
