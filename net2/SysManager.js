/*    Copyright 2016-2022 Firewalla Inc.
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
const _ = require('lodash');
const log = require('./logger.js')(__filename);

const util = require('util');
const fs = require('fs')

const iptool = require('ip');
var instance = null;
const license = require('../util/license.js');
const rp = require('request-promise');
const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()
const { delay } = require('../util/util.js')
const LRU = require('lru-cache');

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const Mode = require('./Mode.js');

const exec = require('child-process-promise').exec

const serialFiles = ["/sys/block/mmcblk0/device/serial", "/sys/block/mmcblk1/device/serial","/sys/block/sda/device/wwid"];

const bone = require("../lib/Bone.js");

const sss = require('../extension/sysinfo/SysInfo.js');

const Config = require('./config.js');

const fireRouter = require('./FireRouter.js')
const Message = require('./Message.js');

const { Address4, Address6 } = require('ip-address')
const ipUtilMap = {
  4: {
    class: Address4,
    linkLocal: new Address4('169.254.0.0/16'),
  },
  6: {
    class: Address6,
    linkLocal: new Address6('fe80::/10'),
  },
}

var systemDebug = false;

function setSystemDebug(_systemDebug) {
  if (license.getLicense() == null) {
    systemDebug = true;
  } else {
    systemDebug = _systemDebug;
  }
}

setSystemDebug(systemDebug);

const f = require('../net2/Firewalla.js');

const i18n = require('../util/i18n.js');

const dns = require('dns');
const Constants = require('./Constants.js');
const CIDRTrie = require('../util/CIDRTrie.js');
// dnscache will override functions in dns
const dnscache = require('../vendor_lib/dnscache/dnscache.js')({
  enable: true,
  ttl: 300,
  cachesize: 1000
});

class SysManager {
  constructor() { // loglevel is already ignored
    if (instance == null) {
      log.info('Initializing SysManager')
      rclient.hdel("sys:network:info", "oper");
      this.multicastlow = iptool.toLong("224.0.0.0");
      this.multicasthigh = iptool.toLong("239.255.255.255");
      this.repo = {};
      this.ipIntfCache = new LRU({max: 4096, maxAge: 900 * 1000}); // reduce call to inMySubnets4/6 in getInterfaceViaIP4/6, which is CPU intensive, the cache will be flushed if network info is updated
      this.iptablesReady = false;
      this.cidr4Trie = new CIDRTrie(4);
      this.monitoringCidr4Trie = new CIDRTrie(4);
      this.cidr6Trie = new CIDRTrie(6);
      this.monitoringCidr6Trie = new CIDRTrie(6);
      instance = this;
      sem.once('IPTABLES_READY', () => {
        log.info("Iptables is ready");
        this.iptablesReady = true;
      })

      this.ts = Date.now() / 1000;
      log.info("Init", this.ts);
      sclient.on("message", (channel, message) => {
        log.debug("Msg", this.ts, channel, message);
        switch (channel) {
          case "System:Upgrade:Hard":
            this.upgradeEvent = message;
            log.info("[pubsub] System:Upgrade:Hard", this.ts, this.upgradeEvent);
            break;
          case "System:DebugChange":
            if (message === "1") {
              systemDebug = true;
            } else if (message === "0") {
              systemDebug = false;
            } else {
              log.error("invalid message for channel: " + channel);
              return;
            }
            setSystemDebug(systemDebug);
            log.info("[pubsub] System Debug is changed to " + message);
            break;
          case "System:LanguageChange":
            this.language = message;
            i18n.setLocale(this.language);
            break;
          case "System:TimezoneChange":
            this.reloadTimezone().then(() => {
              if (f.isMain()) {
                pclient.publish(Message.MSG_SYS_TIMEZONE_RELOADED, message);
              }
            }).catch((err) => {
              log.error("Failed to reload timezone", err.message);
            });
            break;
          case Message.MSG_SYS_NETWORK_INFO_UPDATED:
            log.info(Message.MSG_SYS_NETWORK_INFO_UPDATED, 'initiate update')
            this.update(() => {
              this.ipIntfCache.reset();
              sem.emitLocalEvent({ type: Message.MSG_SYS_NETWORK_INFO_RELOADED })
            });
            break;
        }
      });
      sclient.subscribe("System:DebugChange");
      sclient.subscribe("System:LanguageChange");
      sclient.subscribe("System:TimezoneChange");
      sclient.subscribe("System:Upgrade:Hard");
      sclient.subscribe(Message.MSG_SYS_NETWORK_INFO_UPDATED);

      sem.on(Message.MSG_FW_FR_RELOADED, () => {
        this.update(() => {
          this.ipIntfCache.reset();
          sem.emitLocalEvent({ type: Message.MSG_SYS_NETWORK_INFO_RELOADED })
        });
      });

      this.reloadTimezone();

      this.license = license.getLicense();

      sem.on("PublicIP:Updated", (event) => {
        if (event.hasOwnProperty("ip"))
          this.publicIp = event.ip;
        if (event.hasOwnProperty("ip6s"))
          this.publicIp6s = event.ip6s;
        if (event.hasOwnProperty("wanIPs"))
          this.publicIps = event.wanIPs;
      });
      sem.on("DDNS:Updated", (event) => {
        log.info("Updating DDNS:", event);
        if (event.ddns) {
          this.ddns = event.ddns;
        }

        if (event.publicIp) {
          this.publicIp = event.publicIp;
        }
      })
      sem.on("LocalDomainUpdate", async (event) => {
        const macArr = event.macArr || [];
        if (macArr.includes('0.0.0.0')) {
          const suffix = await rclient.getAsync(Constants.REDIS_KEY_LOCAL_DOMAIN_SUFFIX);
          this.localDomainSuffix = suffix && suffix.toLowerCase() || "lan";
        }
      })

      // only in hard upgrade mode
      rclient.get("sys:upgrade", (err, data) => {
        if (data) {
          this.upgradeEvent = data;
        }
      });

      // record firewalla's own server address
      //
      this.resolveServerDNS(true);
      setInterval(() => {
        this.resolveServerDNS(false);
      }, 1000 * 60 * 60 * 8);

      // update system information more often
      setInterval(() => {
        this.update(null);
      }, 1000 * 60 * 20);
    }
    fireRouter.waitTillReady().then(() => {
      this.update((err) => {
        if (err)
          log.error(`Failed to update SysManager after firerouter is ready`, err.message);
        else
          log.info("SysManager initialization complete");
      });
    });

    return instance
  }

  isIptablesReady() {
    return this.iptablesReady
  }

  async waitTillIptablesReady() {
    if (this.iptablesReady) return

    await delay(1000)
    return this.waitTillIptablesReady()
  }

  resolveServerDNS(retry) {
    dns.resolve4('firewalla.encipher.io', (err, addresses) => {
      log.info("resolveServerDNS:", retry, err && err.message, addresses);
      if (err && retry) {
        setTimeout(() => {
          this.resolveServerDNS(false);
        }, 1000 * 60 * 10);
      } else {
        if (addresses) {
          this.serverIps = addresses;
          log.info("resolveServerDNS:Set", retry, err && err.message, this.serverIps);
        }
      }
    });
  }

  updateInfo() {
    this.ept = bone.getSysept();
  }

  // config loaded, sys:network:info loaded and interface discovered
  isConfigInitialized() {
    return this.config != null && this.sysinfo && fireRouter.isReady();
  }

  async waitTillInitialized() {
    if (this.config != null && this.sysinfo && fireRouter.isReady())
      return;
    await delay(1000);
    return this.waitTillInitialized();
  }

  version() {
    if (this.config != null && this.config.version != null) {
      return this.config.version;
    } else {
      return "unknown";
    }
  }

  /**
   * Only call release function when the SysManager instance is no longer
   * needed
   */
  release() {
    rclient.quit();
    sclient.quit();
    log.info("Calling release function of SysManager");
  }

  debugOn(callback) {
    rclient.set("system:debug", "1", (err) => {
      systemDebug = true;
      pclient.publish("System:DebugChange", "1");
      callback(err);
    });
  }

  debugOff(callback) {
    rclient.set("system:debug", "0", (err) => {
      systemDebug = false;
      pclient.publish("System:DebugChange", "0");
      callback(err);
    });
  }

  isSystemDebugOn() {
    return systemDebug;
  }

  isBranchJustChanged() {
    return rclient.hgetAsync("sys:config", "branch.changed")
  }

  clearBranchChangeFlag() {
    return rclient.hdelAsync("sys:config", "branch.changed")
  }

  systemRebootedDueToIssue(reset) {
    try {
      if (fs.existsSync("/home/pi/.firewalla/managed_reboot")) {
        log.info("SysManager:RebootDueToIssue");
        if (reset == true) {
          fs.unlinkSync("/home/pi/.firewalla/managed_reboot");
        }
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  systemRebootedByUser(reset) {
    try {
      if (fs.existsSync("/home/pi/.firewalla/managed_real_reboot")) {
        log.info("SysManager:RebootByUser");
        if (reset == true) {
          fs.unlinkSync("/home/pi/.firewalla/managed_real_reboot");
        }
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  setLanguage(language, callback) {
    callback = callback || function () { }

    this.language = language;
    const theLanguage = i18n.setLocale(this.language);
    if (theLanguage !== this.language) {
      callback(new Error("invalid language"))
      return
    }

    rclient.hset("sys:config", "language", language, (err) => {
      if (err) {
        log.error("Failed to set language " + language + ", err: " + err);
      }
      pclient.publish("System:LanguageChange", language);
      callback(err);
    });
  }

  setLanguageAsync(language) {
    return new Promise((resolve, reject) => {
      this.setLanguage(language, (err) => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  async reloadTimezone() {
    this.timezone = await rclient.hgetAsync("sys:config", "timezone");
  }

  getTimezone() {
    return this.timezone || "UTC";
  }

  async setTimezone(timezone) {
    if (this.timezone == timezone) {
      return null;
    }
    this.timezone = timezone;
    try {
      await rclient.hsetAsync("sys:config", "timezone", timezone);
      pclient.publish("System:TimezoneChange", timezone);

      await exec(`sudo timedatectl set-timezone ${timezone}`);
      await exec('sudo systemctl restart cron.service');
      await exec('sudo systemctl restart rsyslog');

      return null;
    } catch (err) {
      log.error("Failed to set timezone:", err);
      return err;
    }
  }

  update(callback) {
    if (!callback) callback = () => { }

    return util.callbackify(this.updateAsync).bind(this)(callback)
  }

  async updateAsync() {
    log.debug("Loading sysmanager data from redis");
    try {
      const results = await rclient.hgetallAsync("sys:config")
      if (results && results.language) {
        this.language = results.language;
        i18n.setLocale(this.language);
      }

      if (results && results.timezone) {
        this.timezone = results.timezone;
      }
    } catch (err) {
      log.error('Error getting sys:config', err)
    }

    try {
      const result = await rclient.getAsync("system:debug")
      if (result && result === "1") {
        systemDebug = true;
      } else {
        // by default off
        systemDebug = false;
      }
    } catch (err) {
      log.error('Error getting system:debug', err)
    }

    try {
      const results = await rclient.hgetallAsync("sys:network:info")
      for (const key of Object.keys(results)) {
        results[key] = JSON.parse(results[key]);
        if (_.isObject(results[key]) && results[key].hasOwnProperty("ip_address")) {
          // exclude legacy interfaces in sys:network:info
          if (!fireRouter.getLogicIntfNames().includes(key))
            delete results[key];
        }
      }
      this.sysinfo = results;

      if (this.sysinfo === null) {
        throw new Error('Empty key');
      }

      const monitoringInterfaces = fireRouter.getMonitoringIntfNames();
      const cidr4Trie = new CIDRTrie(4);
      const monitoringCidr4Trie = new CIDRTrie(4);
      const cidr6Trie = new CIDRTrie(6);
      const monitoringCidr6Trie = new CIDRTrie(6);
      for (let r in this.sysinfo) {
        const item = this.sysinfo[r]
        if (item && _.isObject(item)) {
          if (item.subnet) {
            this.sysinfo[r].subnetAddress4 = new Address4(item.subnet)
            cidr4Trie.add(item.subnet, r);
            if (monitoringInterfaces.includes(r))
              monitoringCidr4Trie.add(item.subnet, r);
          }

          if (item.ip6_subnets && item.ip6_subnets.length) {
            const nonLinkLocal = item.ip6_subnets
              .filter(_.isString)
              .map(n => new Address6(n))
              .filter(a => !a.isLinkLocal())
            // multiple IPs in same subnet might be assigned
            this.sysinfo[r].subnetAddress6 = _.uniqWith(nonLinkLocal, (a,b) =>
              a.startAddress().canonicalForm() == b.startAddress().canonicalForm() && a.subnetMask == b.subnetMask
            )
            for (const subnet6 of this.sysinfo[r].subnetAddress6) {
              cidr6Trie.add(`${subnet6.correctForm()}/${subnet6.subnetMask}`, r);
              if (monitoringInterfaces.includes(r))
                monitoringCidr6Trie.add(`${subnet6.correctForm()}/${subnet6.subnetMask}`, r);
            }
          }
        }
      }
      this.cidr4Trie = cidr4Trie;
      this.monitoringCidr4Trie = monitoringCidr4Trie;
      this.cidr6Trie = cidr6Trie;
      this.monitoringCidr6Trie = monitoringCidr6Trie;

      this.config = await Config.getConfig(true)
      if (this.sysinfo['oper'] == null) {
        this.sysinfo.oper = {};
      }
      this.ddns = this.sysinfo["ddns"];
      this.publicIp = this.sysinfo["publicIp"];
      this.publicIps = this.sysinfo["publicIps"];
      this.publicIp6s = this.sysinfo["publicIp6s"];
      const suffix = await rclient.getAsync(Constants.REDIS_KEY_LOCAL_DOMAIN_SUFFIX);
      this.localDomainSuffix = suffix && suffix.toLowerCase() || "lan";
      // log.info("System Manager Initialized with Config", this.sysinfo);
    } catch (err) {
      log.error('Error getting sys:network:info', err)
    }

    try {
      const uuidMap = await rclient.hgetallAsync('sys:network:uuid')
      for (const uuid of Object.keys(uuidMap)) {
        const obj = JSON.parse(uuidMap[uuid]);
        uuidMap[uuid] = obj
        const name = obj.name;
        if (!name || !this.sysinfo[name] || this.sysinfo[name].uuid !== uuid)
          delete uuidMap[uuid];
      }
      this.uuidMap = uuidMap;
    } catch (err) {
      log.error('Error getting sys:network:uuid', err)
    }
  }

  async syncVersionUpdate() {
    const version = this.version();
    if (!version || version === "unknown") return;
    const isKnownVersion = await rclient.sismemberAsync("sys:versionHistory", version);
    if (!isKnownVersion) {
      const versionDesc = { version: version, time: Math.floor(Date.now() / 1000) };
      await rclient.setAsync("sys:versionUpdate", JSON.stringify(versionDesc));
      await rclient.saddAsync("sys:versionHistory", version);
    }
  }

  async getVersionUpdate() {
    return rclient.getAsync("sys:versionUpdate").then((versionDesc) => {
      return JSON.parse(versionDesc)
    }).catch((err) => {
      return null;
    });
  }

  async clearVersionUpdate() {
    return rclient.delAsync("sys:versionUpdate");
  }

  setOperationalState(state, value) {
    this.update((err) => {
      this.sysinfo['oper'][state] = value;
      rclient.hset("sys:network:info", "oper", JSON.stringify(this.sysinfo['oper']), (err, result) => {
        if (err == null) {
          //log.info("System Operational Changed",state,value,this.sysinfo['oper']);
        }
      });
    });
  }

  getLogicInterfaces() {
    return fireRouter.getLogicIntfNames().map(name => this.sysinfo[name]).filter(i => i); // filter null or undefined object in case this.sysinfo is reloaded halfway
  }

  getMonitoringInterfaces() {
    return fireRouter.getMonitoringIntfNames().map(name => this.sysinfo[name]).filter(i => i); // filter null or undefined object in case this.sysinfo is reloaded halfway
  }

  getInterfaces(monitoringOnly = true) {
    return monitoringOnly ? this.getMonitoringInterfaces() : this.getLogicInterfaces()
  }

  getInterface(intf) {
    return this.sysinfo && this.sysinfo[intf]
  }

  getInterfaceViaUUID(uuid) {
    const intf = this.uuidMap && this.uuidMap[uuid]
    if (_.isEmpty(intf)) return null

    const active = this.getMonitoringInterfaces().some(i => i.uuid == uuid)
    return Object.assign({}, active ? this.getInterface(intf.name) : intf, { active })
  }

  getInterfaceViaIP(ip, monitoringOnly = true) {
    if (!ip)
      return null;
    let intf = this.ipIntfCache.get(ip);
    if (intf)
      return intf;
    if (new Address4(ip).isValid()) {
      intf = this.getInterfaceViaIP4(ip, monitoringOnly);
    } else {
      intf = this.getInterfaceViaIP6(ip, monitoringOnly);
    }
    if (intf)
      this.ipIntfCache.set(ip, intf);
    return intf;
  }

  getInterfaceViaIP4(ip, monitoringOnly = true) {
    if (!ip) return null;
    let intf = null;
    if (monitoringOnly)
      intf = this.monitoringCidr4Trie.find(ip);
    else
      intf = this.cidr4Trie.find(ip);
    return intf && this.getInterface(intf);

  }

  getInterfaceViaIP6(ip6, monitoringOnly = true) {
    if (!ip6) return null;
    let intf = null;
    if (monitoringOnly)
      intf = this.monitoringCidr6Trie.find(ip6);
    else
      intf = this.cidr6Trie.find(ip6);
    return intf && this.getInterface(intf);
  }

  mySignatureMac() {
    return platform.getSignatureMac();
  }

  getDefaultWanInterface() {
    const wanIntf = fireRouter.getDefaultWanIntfName();
    return wanIntf && this.getInterface(wanIntf);
  }

  getPrimaryWanInterface() {
    const primaryWanIntf = fireRouter.getPrimaryWanIntfName();
    return primaryWanIntf && this.getInterface(primaryWanIntf);
  }

  getWanType() {
    return fireRouter.getWanType();
  }

  getWanInterfaces() {
    return this.getInterfaces(false).filter(iface => (fireRouter.getWanIntfNames() || []).includes(iface.name));
  }

  myWanIps(connected) {
    const wanIntfs = fireRouter.getWanIntfNames() || [];
    const wanIp4 = new Set()
    const wanIp6 = new Set()
    for (const wanIntf of wanIntfs) {
      const intf = this.getInterface(wanIntf);
      if (intf) {
        if (connected !== undefined && connected !== null) {
          if (intf.ready != connected) continue
        }

        !_.isEmpty(intf.ip4_addresses) && intf.ip4_addresses.forEach(ip => wanIp4.add(ip));
        !_.isEmpty(intf.ip6_addresses) && intf.ip6_addresses.forEach(ip => wanIp6.add(ip));
      }
    }
    return { v4: Array.from(wanIp4), v6: Array.from(wanIp6) }
  }

  myDefaultWanIp() {
    const wanIntf = fireRouter.getDefaultWanIntfName();
    if (wanIntf)
      return this.myIp(wanIntf);
    return null;
  }

  myDefaultWanIp6() {
    const wanIntf = fireRouter.getDefaultWanIntfName();
    if (wanIntf)
      return this.myIp6(wanIntf);
    return null;
  }

  // filter Carrier-Grade NAT address pool accordinig to rfc6598
  filterPublicIp4(ipArray) {
    const rfc6598Net = iptool.subnet("100.64.0.0", "255.192.0.0")
    return ipArray.filter(ip => iptool.isPublic(ip) && !rfc6598Net.contains(ip));
  }

  filterPublicIp6(ip6Array) {
    return ip6Array.filter(ip => iptool.isPublic(ip));
  }

  myGateways() {
    const wanIntfs = fireRouter.getWanIntfNames();
    return wanIntfs.reduce((acc,wanIntf) => {
      const gw = this.myGateway(wanIntf);
      if (gw) acc.push(gw);
      return acc;
    },[]);
  }

  myDefaultGateway() {
    const wanIntf = fireRouter.getDefaultWanIntfName();
    if (wanIntf)
      return this.myGateway(wanIntf);
    return null;
  }

  myDefaultGateway6() {
    const wanIntf = fireRouter.getDefaultWanIntfName();
    if (wanIntf)
      return this.myGateway6(wanIntf);
    return null;
  }

  myDnses() {
    const wanIntfs = fireRouter.getWanIntfNames();
    return wanIntfs.reduce((acc,wanIntf) => {
      acc = [ ...new Set([...acc, ...this.myDNS(wanIntf)]) ];
      return acc;
    },[]);
  }

  myDefaultDns() {
    const wanIntf = fireRouter.getDefaultWanIntfName();
    if (wanIntf)
      return this.myDNS(wanIntf);
    return [];
  }

  myIp(intf = this.config.monitoringInterface) {
    return this.getInterface(intf) && this.getInterface(intf).ip_address;
  }

  isMyIP(ip, monitoringOnly = true) {
    if (!ip) return false
    let interfaces = this.getInterfaces(monitoringOnly);
    return interfaces.some(i => i.ip_address === ip);
  }

  isIPv6GloballyConnected() {
    let ipv6Addrs = this.myIp6();
    if (ipv6Addrs && ipv6Addrs.length > 0) {
      for (const ip6 in ipv6Addrs) {
        if (!ip6.startsWith("fe80")) {
          return true;
        }
      }
    }
    return false;
  }

  isLocalDomain(d) {
    return d && this.localDomainSuffix && d.toLowerCase().endsWith(`.${this.localDomainSuffix}`);
  }

  isSearchDomain(d) {
    return this.getMonitoringInterfaces().some(intf => d && _.isArray(intf.searchDomains) && intf.searchDomains.some(sd => d.toLowerCase().endsWith(`.${sd.toLowerCase()}`)));
  }

  myIp2(intf = this.config.monitoringInterface) {
    const if2 = intf + ':0'
    return this.getInterface(if2) && this.getInterface(if2).ip_address;
  }

  // This returns an array
  myIp6(intf = this.config.monitoringInterface) {
    return this.getInterface(intf) && this.getInterface(intf).ip6_addresses;
  }

  isMyIP6(ip6, monitoringOnly = true) {
    let interfaces = this.getInterfaces(monitoringOnly);
    return interfaces.some(i => i.ip6_addresses && i.ip6_addresses.includes(ip6));
  }

  myIpMask(intf = this.config.monitoringInterface) {
    const intfObj = this.getInterface(intf)
    if (intfObj) {
      const mask = this.getInterface(intf).netmask;
      if (mask) {
        if (mask.startsWith("Mask:"))
          return mask.substr(5);
        else
          return mask;
      } else {
        // parse subnet when netmask does not exist
        return iptool.cidrSubnet(intfObj.subnet).subnetMask
      }
    } else {
      return undefined;
    }
  }

  myIpMask2(intf = this.config.monitoringInterface) {
    return this.myIpMask(intf + ':0')
  }

  isFirewallaMac(mac) {
    return mac.startsWith('20:6D:31')
  }

  isMyMac(mac) {
    if (!mac) return false

    let interfaces = this.getLogicInterfaces();
    return interfaces.map(i => i.mac_address && i.mac_address.toUpperCase() === mac.toUpperCase()).some(Boolean);
  }

  myMAC(intf = this.config.monitoringInterface) {
    return this.getInterface(intf)
      && this.getInterface(intf).mac_address
      && this.getInterface(intf).mac_address.toUpperCase();
  }

  myMACViaIP4(ip) {
    const intf = this.getLogicInterfaces().find(i => i.ip_address === ip);
    return intf && intf.mac_address && intf.mac_address.toUpperCase();
  }

  myMACViaIP6(ip) {
    const intf = this.getLogicInterfaces().find(i => Array.isArray(i.ip6_addresses) && i.ip6_addresses.includes(ip));
    return intf && intf.mac_address && intf.mac_address.toUpperCase();
  }

  myDDNS() {
    return this.ddns;
  }

  myResolver(intf) {
    if (!intf)
      return [];
    const resolver = (this.getInterface(intf) && this.getInterface(intf).resolver) || [];
    const resolver4 = resolver.filter(r => new Address4(r).isValid())
    return resolver4;
  }

  myResolver6(intf) {
    if (!intf)
      return [];
    const resolver = (this.getInterface(intf) && this.getInterface(intf).resolver) || [];
    const resolver6 = resolver.filter(r => new Address6(r).isValid())
    return resolver6;
  }

  myDNS(intf = this.config.monitoringInterface) { // return array
    let _dns = (this.getInterface(intf) && this.getInterface(intf).dns) || [];
    let v4dns = [];
    for (let i in _dns) {
      if (new Address4(_dns[i]).isValid()) {
        v4dns.push(_dns[i]);
      }
    }
    return v4dns;
  }

  myGateway(intf = this.config.monitoringInterface) {
    return this.getInterface(intf) && this.getInterface(intf).gateway;
  }

  async myGatewayMac(intf = this.config.monitoringInterface) {
    const ip = this.myGateway(intf);
    return rclient.hget(`host:ip4:${ip}`, 'mac')
  }

  myGateway6(intf = this.config.monitoringInterface) {
    return this.getInterface(intf) && this.getInterface(intf).gateway6;
  }

  mySubnet(intf = this.config.monitoringInterface) {
    return this.getInterface(intf) && this.getInterface(intf).subnet;
  }

  mySubnet2(intf = this.config.monitoringInterface) {
    const if2 = intf + ':0'
    return this.getInterface(if2) && this.getInterface(if2).subnet;
  }

  mySubnetNoSlash(intf) {
    let subnet = this.mySubnet(intf);
    return subnet.substring(0, subnet.indexOf('/'));
  }

  isOurCloudServer(host) {
    return host === "firewalla.encipher.io";
  }

  inMySubnets4(ip4, intf, monitoringOnly = true) {
    if (intf) {
      ip4 = new Address4(ip4)
      if (!ip4.isValid()) return false;
      const interfaces = this.getInterfaces(monitoringOnly).filter(i => i.name === intf);
      return interfaces
        .some(i => Array.isArray(i.ip4_subnets) &&
          i.ip4_subnets.some(subnet => ip4.isInSubnet(new Address4(subnet)))
      )
    } else {
      if (monitoringOnly)
        return this.monitoringCidr4Trie.find(ip4) != null;
      else
        return this.cidr4Trie.find(ip4) != null;
    }
  }

  inMySubnet6(ip6, intf, monitoringOnly = true) {
    if (intf) {
      ip6 = new Address6(ip6)

      if (!ip6.isValid())
        return false;
      else {
        const interfaces = this.getInterfaces(monitoringOnly).filter(i => i.name === intf);
        return interfaces
          .some(i => Array.isArray(i.subnetAddress6) &&
            // link local address is not accurate to determine subnet
            i.subnetAddress6.some(subnet => ip6.isInSubnet(subnet))
          )
      }
    } else {
      if (monitoringOnly)
        return this.monitoringCidr6Trie.find(ip6) != null;
      else
        return this.cidr6Trie.find(ip6) != null;
    }
  }

  // hack ...
  debugState(component) {
    if (component == "FW_HASHDEBUG") {
      return true;
    }
    return false;
  }

  // serial may not come back with anything for some platforms

  getSysInfo(callback = () => { }) {
    return util.callbackify(this.getSysInfo).bind(this)(callback)
  }

  /*
  -rw-rw-r-- 1 pi pi  7 Sep 30 06:53 REPO_BRANCH
  -rw-rw-r-- 1 pi pi 41 Sep 30 06:55 REPO_HEAD
  -rw-rw-r-- 1 pi pi 19 Sep 30 06:55 REPO_TAG
  */


  async getSysInfoAsync() {
    // Fetch statics only once, they should only be updated when services are restarted
    if (!this.serial) {
      let serial = null;
      if (f.isDocker() || f.isTravis()) {
        serial = (await exec("basename \"$(head /proc/1/cgroup)\" | cut -c 1-12")).toString().replace(/\n$/, '')
      } else {
        for (let index = 0; index < serialFiles.length; index++) {
          const serialFile = serialFiles[index];
          try {
            serial = fs.readFileSync(serialFile, 'utf8');
            if ( serial !== null ) serial = serial.trim().split(/\s+/).slice(-1)[0];
            break;
          } catch (err) {
          }
        }

        if (serial === null) {
          serial = "unknown";
        }

        serial = serial.trim();
      }
      this.serial = serial;
    }

    let cpuTemperature = 50; // stub cpu value for docker/travis
    let cpuTemperatureList = [cpuTemperature]
    if (!f.isDocker() && !f.isTravis()) {
      if (platform.hasMultipleCPUs()) {
        const list = await platform.getCpuTemperature();
        cpuTemperature = list[0]
        cpuTemperatureList = list
      } else {
        cpuTemperature = await platform.getCpuTemperature();
        cpuTemperatureList = [cpuTemperature]
      }
    }

    try {
      this.repo.branch = this.repo.branch || fs.readFileSync("/tmp/REPO_BRANCH", "utf8").trim();
      this.repo.head = this.repo.head || fs.readFileSync("/tmp/REPO_HEAD", "utf8").trim();
      this.repo.tag = this.repo.tag || fs.readFileSync("/tmp/REPO_TAG", "utf8").trim();
    } catch (err) {
      log.error("Failed to load repo info from /tmp", err);
    }
    // ======== end of statics =========

    // TODO: support v6
    let publicWanIps = null;
    let publicWanIp6s = null;
    if (await Mode.isRouterModeOn()) {
      publicWanIps = this.filterPublicIp4(this.myWanIps(true).v4);
      publicWanIp6s = this.filterPublicIp6(this.myWanIps(true).v6);
    }


    const stat = require("../util/Stats.js");
    const memory = await util.promisify(stat.sysmemory)()
    return {
      ip: this.myDefaultWanIp(),
      ip6: this.myDefaultWanIp6(),
      mac: this.mySignatureMac(),
      serial: this.serial,
      repoBranch: this.repo.branch,
      repoHead: this.repo.head,
      repoTag: this.repo.tag,
      language: this.language,
      timezone: this.timezone,
      memory,
      cpuTemperature,
      cpuTemperatureList,
      sss: sss.getSysInfo(),
      publicWanIps,
      publicWanIp6s,
      publicIp: this.publicIp,
      publicIp6s: this.publicIp6s
    }
  }

  isLinkLocal(ip, family) {
    try {
      // check both families if not specified
      for (const f of family ? [family] : [4,6]) {
        const address = ip instanceof ipUtilMap[f].class ? ip : new ipUtilMap[f].class(ip)
        if (address.isValid())
          return address.isInSubnet(ipUtilMap[f].linkLocal)
      }

      return false
    } catch(err) {
      log.error('Failed to parse address', ip)
      return false
    }
  }

  // if the ip is part of our cloud, no need to log it, since it might cost space and memory
  isMyServer(ip) {
    if (this.serverIps) {
      return (this.serverIps.indexOf(ip) > -1);
    }
    return false;
  }

  isMulticastIP4(ip, intf, monitoringOnly = true) {
    try {
      if (!new Address4(ip).isValid()) return false

      if (ip == "255.255.255.255") return true

      const intfObj = intf ? this.getInterface(intf) : this.getInterfaceViaIP(ip, monitoringOnly)

      if (intfObj && intfObj.subnet) {
        const subnet = new Address4(intfObj.subnet)
        if (subnet.subnetMask < 32 &&
          (ip == subnet.startAddress().address || ip == subnet.endAddress().address)
        ) return true
      }

      return (iptool.toLong(ip) >= this.multicastlow && iptool.toLong(ip) <= this.multicasthigh)
    } catch (e) {
      log.error("SysManager:isMulticastIP4", ip, intf, monitoringOnly, e);
      return false;
    }
  }

  isMulticastIP6(ip) {
    return ip.startsWith("ff");
  }

  isMulticastIP(ip, intf, monitoringOnly = true) {
    try {
      if (new Address4(ip).isValid()) {
        return this.isMulticastIP4(ip, intf, monitoringOnly);
      } else {
        return this.isMulticastIP6(ip);
      }
    } catch (e) {
      log.error("SysManager:isMulticastIP", ip, intf, monitoringOnly, e);
      return false;
    }
  }

  // if intf is not specified, check with all interfaces
  isLocalIP(ip, intf) {
    if (!ip || ip == 'undefined' || ip == 'null') {
      log.verbose("SysManager:WARN:isLocalIP empty ip");
      // TODO: we should throw error here
      return false;
    }

    if (new Address4(ip).isValid()) {
      if (this.isMulticastIP4(ip, intf) || ip == '127.0.0.1') {
        return true;
      }
      return this.inMySubnets4(ip, intf)

    } else if (new Address6(ip).isValid()) {
      if (ip.startsWith('::')) {
        return true;
      }
      if (this.isMulticastIP6(ip)) {
        return true;
      }
      if (ip.startsWith('fe80')) {
        return true;
      }
      return this.inMySubnet6(ip, intf);
    } else {
      log.error(new Error("isLocalIP, not valid ip: " + ip));
      // TODO: we should throw error here
      return false;
    }
  }

  isSystemDomain(ipOrDomain) {
    if (ipOrDomain.indexOf('encipher.io') > -1) {
      return true;
    }
    return false;
  }

  async getBranchUpdateTime(branch) {
    try {
      const result = await rp({
        uri: `https://api.github.com/repos/firewalla/firewalla/commits/${branch}`,
        headers: {
          "User-Agent": "curl/7.64.1",
        },
        json: true
      })
      return new Date(result.commit.committer.date) / 1000;
    } catch (e) {
      log.warn(`Get ${branch} update time error`, e);
    }
  }
}

module.exports = new SysManager();
