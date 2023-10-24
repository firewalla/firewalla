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
const { Address4, Address6 } = require('ip-address')
const Message = require('../net2/Message.js');
const { modelToType, boardToModel, hapCiToType } = require('../extension/detect/appleModel.js')
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();

const _ = require('lodash')

const ignoredServices = ['_airdrop', '_continuity']
const nonReadableNameServices = ['_raop', '_sleep-proxy', '_remotepairing', '_remotepairing-tunnel', '_apple-mobdev2', '_asquic', '_dacp']

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
    const hashKey = mac + service.type
    if (lastProcessTimeMap[hashKey] && Date.now() / 1000 - lastProcessTimeMap[hashKey] < 30)
      return;

    const hostObj = await hostManager.getHostAsync(mac)

    lastProcessTimeMap[hashKey] = Date.now() / 1000;
    log.verbose("Found a bonjour service from host:", mac, service.name, service.ipv4Addr, service.ipv6Addrs);

    let detect = {}
    const { txt, name, type } = service
    switch (type) {
      // case '_airport':
      //   detect.type = 'router'
      //   detect.brand = 'Apple'
      //   break
      case '_airplay':
      case '_mediaremotetv': {
        const result = await modelToType(txt && txt.model)
        if (result) {
          detect.type = result
          detect.name = name
        }
        break
      }
      case '_raop': {
        const result = await modelToType(txt && txt.am)
        if (result) {
          detect.type = result
          detect.brand = 'Apple'
        }
        break
      }
      case '_sleep-proxy':
      case '_companion-link':
      case '_rdlink': {
        const result = await modelToType(await boardToModel(txt && txt.model))
        if (result) {
          detect.type = result
          detect.brand = 'Apple'
          if (type != '_sleep-proxy') detect.name = name
        }
        break
      }
      case '_hap': // Homekit Accessory Protocol
        if (txt) {
          if (txt.ci) {
            const type = await hapCiToType(txt.ci)
            // lower priority for homekit bridge (2) or sensor (10)
            if (type && !([2, 10].includes(Number(txt.ci)) && _.get(hostObj, 'o.detect.bonjour.type')))
              detect.type = type
          }
          if (txt.md) detect.model = txt.md
        }
        break
      case '_ipp':
      case '_ipps':
      case '_ipp-tls':
      case '_printer':
      case '_pdl-datastream':
        // https://developer.apple.com/bonjour/printing-specification/bonjourprinting-1.2.1.pdf

        // printer could be added as service via airprint as well,
        if (!_.get(hostObj, 'o.detect.bonjour.type')) {
          detect.type = 'printer'
          if (txt) {
            if (txt.ty) detect.name = txt.ty
            if (txt.usb_MDL) detect.model = txt.usb_MDL
            if (txt.usb_MFG) detect.brand = txt.usb_MFG
          }
        }
        break
      case '_amzn-wplay':
        detect.type = 'tv'
        if (txt && txt.n) {
          detect.name = txt.n
        }
        break
    }

    if (Object.keys(detect).length) {
      log.verbose('Bonjour', mac, detect)
      sem.emitLocalEvent({
        type: 'DetectUpdate',
        from: 'bonjour',
        mac,
        detect,
        suppressEventLogging: true,
      })
    }

    const host = {
      mac: mac,
      from: "bonjour"
    };

    if (service.name && service.name.length)
      host.bname = service.name

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
      suppressEventLogging: true,
    })
  }

  getHostName(service) {
    let name = service.host.replace(".local", "");
    return name;
  }

  getFriendlyDeviceName(service) {
    // doubt that we are still using this
    let bypassList = [/eph:devhi:netbot/]

    let name

    if (!service.name ||
      service.fqdn && bypassList.some((x) => service.fqdn.match(x)) ||
      nonReadableNameServices.includes(service.type)
    ) {
      name = this.getHostName(service)
    } else {
      name = service.name
    }

    name = name.replace(/[ _\-\[\(]*(([0-9a-f]{2}:?){6}|[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}|[0-9a-f]{32})[\]\)]?/ig, "") // remove mac & uuid
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

    // not really helpful on recognizing name & type
    if (ignoredServices.includes(service.type)) {
      return
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
      name: this.getFriendlyDeviceName(service),
      ipv4Addr: ipv4addr,
      ipv6Addrs: ipv6addr,
      hostName: service.host,
      type: service.type,
      txt: service.txt,
    };

    this.processService(s);
  }
}

module.exports = BonjourSensor;
