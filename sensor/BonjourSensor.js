/*    Copyright 2016-2024 Firewalla Inc.
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

const net = require('net')

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const sem = require('./SensorEventManager.js').getInstance();

const Bonjour = require('../vendor_lib/bonjour');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const sysManager = require('../net2/SysManager.js')
const Message = require('../net2/Message.js');
const { modelToType, boardToModel, hapCiToType } = require('../extension/detect/appleModel.js')
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();

const _ = require('lodash')

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

  async processService(service) {
    const ipv4Addr = service.ipv4Addr;
    const ipv6Addrs = service.ipv6Addrs;

    let mac = null
    if (!mac && ipv4Addr) {
      mac = await hostTool.getMacByIPWithCache(ipv4Addr);
    }
    if (!mac && ipv6Addrs && ipv6Addrs.length !== 0) {
      for (let i in ipv6Addrs) {
        const ipv6Addr = ipv6Addrs[i];
        mac = await hostTool.getMacByIPWithCache(ipv6Addr);
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
    const detected = _.get(hostObj, 'o.detect.bonjour', {})

    lastProcessTimeMap[hashKey] = Date.now() / 1000;

    let detect = {}
    const { txt, name, type } = service
    log.verbose("Found a bonjour service from host:", mac, name, type, service.ipv4Addr, service.ipv6Addrs);
    switch (type) {
      // case '_airport':
      //   detect.type = 'router'
      //   detect.brand = 'Apple'
      //   break
      case '_airplay':
        // airplay almost always has a good readable name, let's use it
        if (name) detect.name = name
        // falls through
      case '_rfb':        // apple-screen-share
      case '_sftp-ssh':   // apple-remote-login
      case '_eppc':       // apple-remote-events 
      case '_mediaremotetv': {
        const result = await modelToType(txt && txt.model)
        if (result) {
          detect.type = result
          detect.brand = 'Apple'
          detect.model = txt.model
          detect.name = name
        } else if (type == '_airplay' && txt) {
          // none apple device airplay https://openairplay.github.io/airplay-spec/service_discovery.html
          if (txt.manufacturer) detect.brand = txt.manufacturer
          if (txt.model) detect.model = txt.model
        }

        break
      }
      case '_raop': { // Remote Audio Output Protocol
        const result = await modelToType(txt && txt.am) || await modelToType(txt && txt.model)
        if (result) {
          detect.type = result
          detect.brand = 'Apple'
          const indexAt = name.indexOf('@')
          if (indexAt != -1)
            detect.name = name.substring(indexAt + 1)
        } else
          service.name = this.getHostName(service.hostName)
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
            if (type && !([2, 10].includes(Number(txt.ci)) && detected.type))
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
        if (!detected.type) {
          detect.type = 'printer'
          if (txt) {
            if (txt.ty) detect.name = txt.ty
            if (txt.usb_MDL) detect.model = txt.usb_MDL
            if (txt.usb_MFG) detect.brand = txt.usb_MFG
          }
        }
        break
      case '_amzn-wplay':
        if (txt && txt.sn == 'DeviceManager') break

        // this is not accurate, TBD: amazon play model to type mapping
        detect.type = 'tv'
        if (txt && txt.n) {
          detect.name = txt.n
          if (txt.n.includes('Echo') || txt.n.includes('echo'))
            detect.type = 'smart speaker'
        }
        break
      case '_tivo-videos':
      case '_tivo-videostream':
        detect.type = 'tv'
        detect.brand = 'TiVo'
        detect.name = name
        if (txt.platform) detect.model = txt.platform
        break
      case '_sonos':
        detect.type = 'smart speaker'
        detect.name = name.includes('@') ? name.substring(name.indexOf('@')+1) : name
        break
      case '_mi-connect':
        try {
          const parsed = JSON.parse(name)
          if (parsed.nm) {
            detect.name = parsed.nm
          }
        } catch(err) { }
        break
      case '_googlecast':
        // googlecast supports both video(TV) and audio(Speaker)
        if (txt) {
          // a standalone service for chromecast group
          if (txt.md == 'Google Cast Group') {
            // this is the group name
            if (txt.fn && !detected.name) detect.name = txt.fn
          } else {
            if (txt.fn) detect.name = txt.fn
            if (txt.md) detect.model = txt.md
          }
        }
        break
      case '_meshcop': // https://www.threadgroup.org/ThreadSpec
        if (txt) {
          if (txt.vn) detect.brand = txt.vn
          if (txt.mn) detect.model = txt.mn
        }
        break
      case '_mqtt':
        if (txt && txt.irobotmcs) {
          const irobotmcs = JSON.parse(txt.irobotmcs)
          detect.brand = 'iRobot'
          detect.type = 'appliance'
          detect.name = irobotmcs.robotname
          if (irobotmcs.mac) mac = irobotmcs.mac.toUpperCase()
        }
        break
      case '_http':
        // ignore _http on comprehensive devices even type is not from bonjour
        if (['phone', 'tablet', 'desktop', 'laptop'].includes(_.get(hostObj, 'o.detect.type'))) {
          return
        }
        break
      // case '_psia': // Physical Security Interoperability Alliance
      // case '_CGI':
      //   detect.type = 'camera'
      //   break
      // case '_amzn-alexa':
      //   // detect.type = 'smart speaker'
      //   break
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

    if (name && name.length && !this.config.ignoreNames.some(n => name.includes(n)) && type != '_mi-connect')
      host.bname = name

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

  getHostName(host) {
    return host.replace(".local", "")
  }

  getFriendlyDeviceName(service) {
    // doubt that we are still using this
    let bypassList = [/eph:devhi:netbot/]

    let name

    if (!service.name ||
      service.fqdn && bypassList.some((x) => service.fqdn.match(x)) ||
      this.config.nonReadableNameServices.includes(service.type)
    ) {
      name = this.getHostName(service.host)
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

    const addresses = service.addresses
    if (!addresses.length)
      return;

    // not really helpful on recognizing name & type
    if (this.config.ignoreServices.includes(service.type)) {
      return
    }

    let ipv4addr = null;
    let ipv6addr = [];

    for (const addr of addresses) {
      const fam = net.isIP(addr)
      if (fam == 4) {
        if (sysManager.isLocalIP(addr)) {
          ipv4addr = addr;
        } else {
          log.debug("Discover:Bonjour:Parsing:NotLocalV4Adress", addr);
        }
      } else if (fam == 6) {
        ipv6addr.push(addr);
      }
    }

    if (!ipv4addr && !ipv6addr.length) {
      return
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
