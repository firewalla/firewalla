/*    Copyright 2016-2019 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bonjour = require('bonjour')();
const Promise = require('bluebird');

const sysManager = require('../net2/SysManager.js')
const Nmap = require('../net2/Nmap.js');
const nmap = new Nmap();
const l2 = require('../util/Layer2.js');
const validator = require('validator');
const { Address4, Address6 } = require('ip-address')

const ipMacCache = {};

// BonjourSensor is used to two purposes:
// 1. Discover new device
// 2. Update info for old devices

class BonjourSensor extends Sensor {
  constructor() {
    super();
    this.interfaces = null;
    this.hostCache = {};

    bonjour._server.mdns.on('warning', (err) => log.warn("Warning on mdns server", err))
    bonjour._server.mdns.on('error', (err) => log.error("Error on mdns server", err))
  }

  run() {
    log.info("Bonjour Watch Starting");
    this.interfaces = sysManager.getMonitoringInterfaces();
    if (this.bonjourBrowserTCP == null) {
      this.bonjourBrowserTCP = bonjour.find({
        protocol: 'tcp'
      }, (service) => {
        this.bonjourParse(service);
      })
      this.bonjourBrowserUDP = bonjour.find({
        protocol: 'udp'
      }, (service) => {
        this.bonjourParse(service);
      });

      // why http?? because sometime http service can't be found via { protocol: 'tcp' }
      // maybe it's bonjour lib's bug
      this.bonjourBrowserHTTP = bonjour.find({
        type: 'http'
      }, (service) => {
        this.bonjourParse(service);
      });

      this.bonjourTimer = setInterval(() => {
        log.info("Bonjour Watch Updating");
        // remove all detected servcies in bonjour browser internally, otherwise BonjourBrowser would do dedup based on service name, and ip changes would be ignored
        Object.keys(this.bonjourBrowserTCP._serviceMap).forEach(fqdn => this.bonjourBrowserTCP._removeService(fqdn));
        Object.keys(this.bonjourBrowserUDP._serviceMap).forEach(fqdn => this.bonjourBrowserUDP._removeService(fqdn));
        Object.keys(this.bonjourBrowserHTTP._serviceMap).forEach(fqdn => this.bonjourBrowserHTTP._removeService(fqdn));
        this.bonjourBrowserTCP.update();
        this.bonjourBrowserUDP.update();
        this.bonjourBrowserHTTP.update();
      }, 1000 * 60 * 5);
    }

    this.bonjourBrowserTCP.stop();
    this.bonjourBrowserUDP.stop();
    this.bonjourBrowserHTTP.stop();

    this.bonjourTimer = setTimeout(() => {
      this.bonjourBrowserTCP.start();
      this.bonjourBrowserUDP.start();
      this.bonjourBrowserHTTP.start();
    }, 1000 * 10);
  }

  // do not process same host in a short time
  isDup(service) {
    let key = service.ipv4Addr;
    if (!key) {
      return true;
    }

    if (this.hostCache[key]) {
      log.debug("Ignoring duplicated bonjour services from same ip:", key);
      return true;
    }

    this.hostCache[key] = 1;
    setTimeout(() => {
      delete this.hostCache[key];
    }, 5 * 1000 * 60); // 5 mins

    return false;
  }

  async _getMacFromIP(ipAddr) {
    if (!ipAddr)
      return null;
    if (ipMacCache[ipAddr]) {
      const entry = ipMacCache[ipAddr];
      if (entry.lastSeen > Date.now() / 1000 - 1800) { // cache is valid for 1800 seconds
        return entry.mac;
      } else {
        delete ipMacCache[ipAddr];
      }
    }
    if (new Address4(ipAddr).isValid()) {
      return new Promise((resolve, reject) => {
        l2.getMAC(ipAddr, (err, mac) => {
          if (err) {
            log.error("Not able to find mac address for host:", ipAddr, mac);
            resolve(null);
          } else {
            if (!mac) {
              for (const intf of this.interfaces) {
                const intfName = intf.name;
                if (ipAddr === sysManager.myIp(intfName)) {
                  resolve(sysManager.myMAC(intfName));
                } else if (ipAddr === sysManager.myWifiIp(intfName)) {// DEPRECATING
                  resolve(sysManager.myWifiMAC(intfName));
                } else {
                  log.error("Not able to find mac address for host:", ipAddr, mac);
                  resolve(null);
                }
              }
            } else {
              ipMacCache[ipAddr] = { mac: mac, lastSeen: Date.now() / 1000 };
              resolve(mac);
            }
          }
        })
      })
    } else if (new Address6(ipAddr).isValid()) {
      let mac = await nmap.neighborSolicit(ipAddr).catch((err) => {
        log.error("Not able to find mac address for host:", ipAddr, err);
        return null;
      })
      if (!mac) {
        for (const intf of this.interfaces) {
          const intfName = intf.name;
          if (sysManager.myIp6(intfName) && sysManager.myIp6(intfName).includes(ipAddr)) {
            mac = sysManager.myMAC(intfName);
          }
        }
      } else {
        ipMacCache[ipAddr] = { mac: mac, lastSeen: Date.now() / 1000 };
        return mac;
      }
    }
    return null;
  }

  async processService(service) {
    const ipv4Addr = service.ipv4Addr;
    const ipv6Addrs = service.ipv6Addrs;

    let mac = null;
    if (ipv4Addr) {
      mac = await this._getMacFromIP(ipv4Addr);
    }
    if (!mac && ipv6Addrs && ipv6Addrs.length !== 0) {
      for (let i in ipv6Addrs) {
        const ipv6Addr = ipv6Addrs[i];
        mac = await this._getMacFromIP(ipv6Addr);
        if (mac)
          break;
      }
    }

    if (!mac)
      return;

    log.info("Found a bonjour service from host:", mac, service.name, service.ipv4Addr, service.ipv6Addrs);

    let host = {
      mac: mac,
      bname: service.name,
      from: "bonjour"
    };

    if (ipv4Addr) {
      host.ipv4 = ipv4Addr;
      host.ipv4Addr = ipv4Addr;
    }

    if (ipv6Addrs)
      host.ipv6Addr = ipv6Addrs;

    sem.emitEvent({
      type: "DeviceUpdate",
      message: `Found a device via bonjour ${ipv4Addr} ${mac}`,
      host: host
    })
  }

  getDeviceName(service) {
    let name = service.host.replace(".local", "");
    if (name.length <= 1) {
      name = service.name;
    }
    return name;
  }

  getFriendlyDeviceName(service) {
    let bypassList = [/_airdrop._tcp/, /eph:devhi:netbot/, /_apple-mobdev2._tcp/]

    if (service.fqdn && bypassList.some((x) => service.fqdn.match(x))) {
      return this.getDeviceName(service)
    }

    let name = service.name
    name = name.replace(/ \[..:..:..:..:..:..\]/, "") // remove useless mac address
    return name
  }

  bonjourParse(service) {
    log.debug("Discover:Bonjour:Parsing:Received", service);
    if (service == null) {
      return;
    }
    if (service.addresses == null ||
      service.addresses.length == 0 ||
      service.referer.address == null) {
      return;
    }

    if (validator.isUUID(this.getDeviceName(service))) {
      return;
    }

    let ipv4addr = null;
    let ipv6addr = [];

    for (const addr of service.addresses) {
      if (new Address4(addr).isValid()) {
        if (sysManager.isLocalIP(addr)) {
          ipv4addr = addr;
        } else {
          log.debug("Discover:Bonjour:Parsing:NotLocalV4Adress", addr);
        }
      } else if (new Address6(addr).isValid()) {
        ipv6addr.push(addr);
      }
    }

    let s = {
      name: this.getDeviceName(service),
      bonjourSName: this.getFriendlyDeviceName(service) || this.getDeviceName(service),
      ipv4Addr: ipv4addr,
      ipv6Addrs: ipv6addr,
      host: service.host
    };

    // do not dedup since it is only run once every 5 minutes
    //if(!this.isDup(s)) {
    this.processService(s);
    //}
  }
}

module.exports = BonjourSensor;
