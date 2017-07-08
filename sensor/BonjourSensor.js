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

let l2 = require('../util/Layer2.js');

// BonjourSensor is used to two purposes:
// 1. Discover new device
// 2. Update info for old devices

class BonjourSensor extends Sensor {
  constructor() {
    super();
    
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
      
      // why http?? because sometime http service can't be found via { protocol: 'tcp' }
      // maybe it's bonjour lib's bug
      this.bonjourBrowserhttp = bonjour.find({
        type: 'http'
      }, (service) => {
        this.bonjourParse(service);
      });
      this.bonjourTimer = setInterval(() => {
        log.info("Bonjour Watch Updating");
        this.bonjourBrowserTcp.update();
        this.bonjourBrowserUdp.update();
        this.bonjourBrowserhttp.update();
      }, 1000 * 60 * 5);
    }

    this.bonjourBrowserTcp.stop();
    this.bonjourBrowserUdp.stop();
    this.bonjourBrowserhttp.stop();

    this.bonjourTimer = setInterval(() => {
      this.bonjourBrowserTcp.start();
      this.bonjourBrowserUdp.start();
      this.bonjourBrowserhttp.start();
    }, 1000 * 5); 
  }

  // do not process same host in a short time
  isDup(service) {
    let key = service.ipv4Addr;
    if(!key) {
      return true;
    }
    
    if(this.hostCache[key]) {
      log.info("Ignoring duplicated bonjour services from same ip:", key, {});
      return true;
    }

    this.hostCache[key] = 1;
    setTimeout(() => {
      delete this.hostCache[key];
    }, 5 * 1000 * 60); // 5 mins
    
    return false;
  }
  
  processService(service) {
    let ipv4Addr = service.ipv4Addr;

    if(!ipv4Addr) {
      return;
    }
    
    log.info("Found a bonjour service from host:", ipv4Addr, {});

    l2.getMAC(ipv4Addr, (err, mac) => {
      
      if(err) {
        // not found, ignore this host
        log.error("Not able to found mac address for host:", ipv4Addr, mac, {});
        return;
      }

      let host = {
        ipv4: ipv4Addr,
        ipv4Addr: ipv4Addr,
        mac: mac,
        bname: service.name,
      };
      
      if(service.ipv6Addrs)
        host.ipv6Addr =  service.ipv6Addrs;

      sem.emitEvent({
        type: "DeviceUpdate",
        message: "Found a device via bonjour",
        host: host
      })
      
    });
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
        log.info("Discover:Bonjour:Parsing:NotLocalV4Adress", addr);
        continue;
      } else if (ip.isV6Format(addr)) {
        ipv6addr.push(addr);
      }
    }

    let s = {
      name: this.getDeviceName(service),
      ipv4Addr: ipv4addr,
      ipv6Addrs: ipv6addr,
      host: service.host
    };
    
    if(!this.isDup(s)) {
      this.processService(s);
    }
  }
}

module.exports = BonjourSensor;
