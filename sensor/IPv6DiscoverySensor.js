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

/*
 * WANRING, Sending Event Disabled until everything is hooked up
 */

'use strict';
let async = require('async');

let log = require('../net2/logger.js')(__filename);

let util = require('util');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let Sensor = require('./Sensor.js').Sensor;

let networkTool = require('../net2/NetworkTool')();
let cp = require('child_process');

let Firewalla = require('../net2/Firewalla');

let xml2jsonBinary = Firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + Firewalla.getPlatform();


class IPv6DiscoverySensor extends Sensor {
  constructor() {
    super();
    this.networkInterface = networkTool.getLocalNetworkInterface();
    this.enabled = true; // very basic feature, always enabled
    let p = require('../net2/MessageBus.js');
    this.publisher = new p('info','Scan:Done', 10);
    log.info("Starting IPv6DiscoverySensor Interfaces [",this.networkInterface,"]");
  }

  run() {
    process.nextTick(() => {
       this.checkAndRunOnce(true);
    });
    setInterval(() => {
       this.checkAndRunOnce(true);
    }, 1000 * 60 * 120); // every 120 minutes, slow scan
    setInterval(() => {
       this.checkAndRunOnce(true);
    }, 1000 * 60 * 5); // every 5 minutes, fast scan
  }

  getNetworkRanges() {
    return this.networkInterface
      .then((results) => {
      return results;
      });
  }

  checkAndRunOnce(fastMode) {
    return this.isSensorEnable()
      .then((result) => {
        if(result) {
          return this.networkInterface
            .then((results) => {
                if (results) {
                    for (let i in results) {
                       let intf = results[i];
                       this.neighborDiscoveryV6(intf.name,intf);
                    }
                }
            })
        }
      }).catch((err) => {
      log.error("Failed to check if sensor is enabled", err, {});
    })
  }

  isSensorEnable() {
    return Promise.resolve(this.enabled);
  }


  ping6ForDiscovery(intf,obj,callback) {
      this.process = require('child_process').exec("ping6 -c2 -I eth0 ff02::1", (err, out, code) => {
          async.eachLimit(obj.ip6_addresses, 5, (o, cb) => {
             let pcmd = "ping6 -B -c 2 -I eth0 -I "+o+"  ff02::1";
             log.info("Discovery:v6Neighbor:Ping6",pcmd);
             require('child_process').exec(pcmd,(err)=>{
                cb();
             });
          }, (err)=>{
              callback(err);
          });
      });
  }

/* WARNING NOT SENDING SEM */
/* !!!!!!!!!!!!!!!!!!!!!!! */
  addV6Host(v6addr,mac,callback) {
      log.info("Found V6 Address ",v6addr,mac);
      callback(null);
      return;
      sem.emitEvent({
        type: "DeviceUpdate",
        message: "A new device found @ NewDeviceHook",
        suppressEventLogging: true,
        suppressAlarm: this.suppressAlarm,
        host:  {
          ipv6: v6addr,
          ipv6Addr: v6addr,
          mac: mac.toUpperCase();
        }
      });
      callback(null);
  }

  neighborDiscoveryV6(intf,obj) {
     if (obj.ip6_addresses==null || obj.ip6_addresses.length<=1) {
         log.info("Discovery:v6Neighbor:NoV6",intf,obj);
         return;
     }
     this.ping6ForDiscovery(intf,obj,(err) => {
         let cmdline = 'ip -6 neighbor show';
         log.info("Running commandline: ", cmdline);

         this.process = require('child_process').exec(cmdline, (err, out, code) => {
            let lines = out.split("\n");
            async.eachLimit(lines, 1, (o, cb) => {
                log.info("Discover:v6Neighbor:Scan:Line", o, "of interface", intf);
                let parts = o.split(" ");
                if (parts[2] == intf) {
                    let v6addr = parts[0];
                    let mac = parts[4].toUpperCase();
                    if (mac == "FAILED" || mac.length < 16) {
                        cb();
                    } else {
                        this.addV6Host(v6addr, mac, (err) => {
                            cb();
                        });
                    }
                } else {
                    cb();
                }
            }, (err) => {});
            });
        });

    }

  isSensorEnable() {
    return Promise.resolve(this.enabled);
  }

}

module.exports = IPv6DiscoverySensor;
