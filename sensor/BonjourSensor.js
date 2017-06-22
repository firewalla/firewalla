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

let log = require('../net2/logger.js')(__filename);

let Sensor = require('./Sensor.js').Sensor;

let sem = require('../sensor/SensorEventManager.js').getInstance();

let bonjour = require('bonjour')();
let ip = require('ip');

let SysManager = require('../net2/SysManager.js');
let sysManager = new SysManager('info');

let async = require('async');

// BonjourSensor is used to two purposes:
// 1. Discover new device
// 2. Update info for old devices

class BonjourSensor extends Sensor {
  constructor() {
    super();

    let HostTool = require('../net2/HostTool')
    this.hostTool = new HostTool();
    
    this.hostCache = {};
  }
  
  run() {
    log.info("Bonjour Watch Starting");

    if (this.bonjourBrowserTcp == null) {
      this.bonjourBrowserTcp = bonjour.find({
        protocol: 'tcp'
      }, (service) => {
        this.bonjourParse(service);
      });
      this.bonjourBrowserUdp = bonjour.find({
        protocol: 'udp'
      }, (service) => {
        this.bonjourParse(service);
      });
      this.bonjourTimer = setInterval(() => {
        log.info("Bonjour Watch Updating");
        this.bonjourBrowserTcp.update();
        this.bonjourBrowserUdp.update();
      }, 1000 * 60 * 5);
    }

    this.bonjourBrowserTcp.stop();
    this.bonjourBrowserUdp.stop();

    this.bonjourTimer = setInterval(() => {
      this.bonjourBrowserTcp.start();
      this.bonjourBrowserUdp.start();
    }, 1000 * 5); 
  }

  processService(service) {
    let ipv4Addr = service.ipv4Addr;

    if(!ipv4Addr) {
      return;
    }
    
    if(hostCache[ipv4Addr]) { // do not process same host in a short time
      return;
    }
    
    hostCache[ipv4Addr] = 1;
    setTimeout(() => {
      delete hostCache[ipv4Addr];
    }, 5 * 1000 * 60); // 5 mins
    
    log.info("Found a bonjour service from host:", ipv4Addr, {});
    
    this.hostTool.ipv4Exists(ipv4)
      .then((found) => {
        if(!found) {
          sem.emitEvent({
            type: "NewDeviceWithIPOnly",
            message: "found a new device via bonjour",
            service: service
          });
          return;
          
        } else {
          // existing device, updating information
          
          this.hostTool
            .getIPv4Entry(ipv4)
            .then((data) => {
              let mac = data.mac;

              sem.emitEvent({
                type: "DeviceStatusUpdate",
                message: "Update device status via bonjour", 
                host: {
                  uid: ipv4,
                  ipv4Addr: ipv4,
                  ipv4: ipv4,
                  firstFoundTimestamp: Date.now() / 1000,
                  bname: service.name,
                  host: service.host,
                  ipv6Addr: service.ipv6Addrs,
                  mac: mac
                }
              });
            })
            .catch((err) => {
            // do nothing if ip address not found in redis
          })
        }
      })
  }

  getDeviceName(service) {
    let name = service.host.replace(".local", "");
    if (name.length <= 1) {
      name = service.name;
    }
    return name;
  }
  
  bonjourParse(service) {
    log.debug("Discover:Bonjour:Parsing:Received", service, {});
      if (service == null) {
      return;
    }
    if (service.addresses == null ||
        service.addresses.length == 0 ||
        service.referer.address == null) {
      return;
    }

    let ipv4addr = null;
    let ipv6addr = [];

    for (let i in service.addresses) {
      let addr = service.addresses[i];
      if (ip.isV4Format(addr) && sysManager.isLocalIP(addr)) {
        ipv4addr = addr;
      } else if (ip.isV4Format(addr)) {
        log.info("Discover:Bonjour:Parsing:NotLocakV4Adress", addr);
        continue;
      } else if (ip.isV6Format(addr)) {
        ipv6addr.push(addr);
      }
    }

    this.processService({
      name: this.getDeviceName(service),
      ipv4Addr: ipv4addr,
      ipv6Addrs: ipv6addr,
      host: service.host
    });
  }
}

module.exports = BonjourSensor;
