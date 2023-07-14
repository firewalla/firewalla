/*    Copyright 2016-2023 Firewalla Inc.
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

const sem = require('./SensorEventManager.js').getInstance();

const Bonjour = require('../vendor_lib/bonjour');

const sysManager = require('../net2/SysManager.js')
const Nmap = require('../net2/Nmap.js');
const nmap = new Nmap();
const l2 = require('../util/Layer2.js');
const validator = require('validator');
const { Address4, Address6 } = require('ip-address')
const Message = require('../net2/Message.js');
const { modelToType } = require('../extension/detect/appleModel.js')

const ipMacCache = {};
const lastProcessTimeMap = {};

// BonjourSensor is used to two purposes:
// 1. Discover new device
// 2. Update info for old devices

class BonjourSensor extends Sensor {
  constructor(config) {
    super(config);
    this.bonjourListeners = [];
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(() => {
      // remove old bonjour listeners
      if (this.startTask)
        clearTimeout(this.startTask);
      if (this.updateTask)
        clearInterval(this.updateTask);

      for (const listener of this.bonjourListeners) {
        if (listener.browser)
          listener.browser.stop();
        if (listener.instance)
          listener.instance.destroy();
      }
      this.bonjourListeners = [];

      // do not initialize bonjour if there is no interface with IP address
      // otherwise dgram.addMembership will emit error and crash the process
      if (sysManager.getMonitoringInterfaces().filter(i => i.ip_address).length == 0)
        return;
      let bound = false;
      // create new bonjour listeners
      for (const iface of sysManager.getMonitoringInterfaces().filter(i => i.ip_address)) {
        const opts = {interface: iface.ip_address};
        if (!bound) {
          // only bind to INADDR_ANY once, otherwise duplicate dgrams will be received on multiple instances
          opts.bind = "0.0.0.0";
          bound = true;
        } else {
          // no need to bind on any address, multicast query can still be sent via interface in opts
          opts.bind = false;
        }
        const instance = Bonjour(opts);
        instance._server.mdns.on('warning', (err) => log.warn(`Warning from mDNS server on ${iface.ip_address}`, err));
        instance._server.mdns.on('error', (err) => log.error(`Error from mDNS server on ${iface.ip_address}`, err));
        const browser = instance.find({}, (service) => this.bonjourParse(service));
        this.bonjourListeners.push({browser, instance});
      }

      this.updateTask = setInterval(() => {
        log.info("Bonjour Watch Updating");
        // remove all detected servcies in bonjour browser internally, otherwise BonjourBrowser would do dedup based on service name, and ip changes would be ignored
        for (const listener of this.bonjourListeners) {
          Object.keys(listener.browser._serviceMap).forEach(fqdn => listener.browser._removeService(fqdn));
          listener.browser.update();
        }
      }, 1000 * 60 * 5);

      this.startTask = setTimeout(() => {
        for (const listener of this.bonjourListeners) {
          listener.browser.start();
        }
      }, 1000 * 10);
    }, 5000);
  }

  run() {
    sem.once('IPTABLES_READY', () => {
      log.info("Bonjour Watch Starting");
      this.scheduleReload();

      sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
        log.info("Schedule reload BonjourSensor since network info is reloaded");
        this.scheduleReload();
      })
    });
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
            log.warn("Not able to find mac address for host:", ipAddr, mac);
            resolve(null);
          } else {
            if (!mac) {
              const myMac = sysManager.myMACViaIP4(ipAddr) || null;
              if (!myMac)
                log.warn("Not able to find mac address for host:", ipAddr, mac);
              resolve(myMac);
            } else {
              ipMacCache[ipAddr] = { mac: mac, lastSeen: Date.now() / 1000 };
              resolve(mac);
            }
          }
        })
      })
    } else if (new Address6(ipAddr).isValid() && !ipAddr.startsWith("fe80:")) { // nmap neighbor solicit is not accurate for link-local addresses
      let mac = await nmap.neighborSolicit(ipAddr).catch((err) => {
        log.warn("Not able to find mac address for host:", ipAddr, err);
        return null;
      })
      if (mac && sysManager.isMyMac(mac))
      // should not get neighbor advertisement of Firewalla itself, this is mainly caused by IPv6 spoof
        mac = null;
      if (!mac) {
        const myMac = sysManager.myMACViaIP6(ipAddr) || null;
        if (!myMac)
          log.warn("Not able to find mac address for host:", ipAddr, mac);
        return myMac
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

    let mac = null
    let detect = {}

    if (service.txt) {
      switch (service.type) {
        case '_airplay':
          mac = service.txt.deviceid
          detect.brand = 'Apple'
          detect.type = modelToType(service.txt.model)
          break
        case '_raop':
          detect.brand = 'Apple'
          detect.type = modelToType(service.txt.am)
          break
        case '_companion-link':
          mac = service.txt.rpba
          break
      }
    }

    if (!mac && ipv4Addr) {
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

    mac = mac.toUpperCase();
    // do not process bonjour from box itself
    if (sysManager.isMyMac(mac))
      return;
    // do not process bonjour messages from same MAC address in the last 30 seconds
    if (lastProcessTimeMap[mac] && Date.now() / 1000 - lastProcessTimeMap[mac] < 30)
      return;

    lastProcessTimeMap[mac] = Date.now() / 1000;
    log.info("Found a bonjour service from host:", mac, service.name, service.ipv4Addr, service.ipv6Addrs);

    if (Object.keys(detect).length) {
      log.info('Bonjour', mac, detect)
      sem.emitLocalEvent({
        type: 'DetectUpdate',
        from: 'bonjour',
        mac,
        detect,
      })
    }

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
      host: host,
      suppressEventLogging: true
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
    let bypassList = [/eph:devhi:netbot/]

    if (service.fqdn && bypassList.some((x) => service.fqdn.match(x))
      || ['_airplay', '_apple-mobdev2', '_companion-link', '_raop'].includes(service.type)
    ) {
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
      host: service.host,
      type: service.type,
      txt: service.txt,
    };

    this.processService(s);
  }
}

module.exports = BonjourSensor;
