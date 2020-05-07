/*    Copyright 2016-2020 Firewalla Inc.
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

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const exec = require('child-process-promise').exec

const serialFiles = ["/sys/block/mmcblk0/device/serial", "/sys/block/mmcblk1/device/serial"];

const bone = require("../lib/Bone.js");

const sss = require('../extension/sysinfo/SysInfo.js');

const Config = require('./config.js');

const fireRouter = require('./FireRouter.js')
const Message = require('./Message.js');

const { Address4, Address6 } = require('ip-address')

var systemDebug = false;

function setSystemDebug(_systemDebug) {
  if (license.getLicense() == null) {
    systemDebug = true;
  } else {
    systemDebug = _systemDebug;
  }
}

setSystemDebug(systemDebug);

let DNSServers = {
  "75.75.75.75": true,
  "75.75.75.76": true,
  "8.8.8.8": true
};

const f = require('../net2/Firewalla.js');

const i18n = require('../util/i18n.js');

const dns = require('dns');

class SysManager {
  constructor() { // loglevel is already ignored
    if (instance == null) {
      log.info('Initializing SysManager')
      rclient.hdel("sys:network:info", "oper");
      this.multicastlow = iptool.toLong("224.0.0.0");
      this.multicasthigh = iptool.toLong("239.255.255.255");
      this.locals = {};
      this.lastIPTime = 0;
      this.repo = {};
      instance = this;

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
          case "System:SSHPasswordChange": {
            const SSH = require('../extension/ssh/ssh.js');
            const ssh = new SSH('info');
            ssh.getPassword((err, password) => {
              this.sshPassword = password;
            });
            break;
          }
          case Message.MSG_SYS_NETWORK_INFO_UPDATED:
            this.update(() => {
              if (f.isMain()) {
                pclient.publish(Message.MSG_SYS_NETWORK_INFO_RELOADED, "");
              }
            });
            break;
        }
      });
      sclient.subscribe("System:DebugChange");
      sclient.subscribe("System:LanguageChange");
      sclient.subscribe("System:TimezoneChange");
      sclient.subscribe("System:Upgrade:Hard");
      sclient.subscribe("System:SSHPasswordChange");
      sclient.subscribe(Message.MSG_SYS_NETWORK_INFO_UPDATED);

      this.delayedActions();
      this.reloadTimezone();

      this.license = license.getLicense();

      sem.on("PublicIP:Updated", (event) => {
        if (event.ip)
          this.publicIp = event.ip;
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
    this.update(null);

    return instance
  }

  resolveServerDNS(retry) {
    dns.resolve4('firewalla.encipher.io', (err, addresses) => {
      log.info("resolveServerDNS:", retry, err, addresses, null);
      if (err && retry) {
        setTimeout(() => {
          this.resolveServerDNS(false);
        }, 1000 * 60 * 10);
      } else {
        if (addresses) {
          this.serverIps = addresses;
          log.info("resolveServerDNS:Set", retry, err, this.serverIps, null);
        }
      }
    });
  }

  updateInfo() {
    this.ept = bone.getSysept();
  }

  // config loaded && interface discovered
  isConfigInitialized() {
    return this.config != null && fireRouter.isReady();
  }

  delayedActions() {
    setTimeout(() => {
      let SSH = require('../extension/ssh/ssh.js');
      let ssh = new SSH('info');

      ssh.getPassword((err, password) => {
        this.setSSHPassword(password);
      });
    }, 2000);
  }

  version() {
    if (this.config != null && this.config.version != null) {
      return this.config.version;
    } else {
      return "unknown";
    }
  }

  setNeighbor(ip) {
    this.locals[ip] = "1";
    log.debug("Sys:Insert:Local", ip, "***");
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

  setSSHPassword(newPassword) {
    this.sshPassword = newPassword;
    pclient.publish("System:SSHPasswordChange", "");
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
      
      //don't restart when initializing timezone
      tz && (await exec('sudo systemctl restart firemain'));
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
      this.sysinfo = results;

      if (this.sysinfo === null) {
        throw new Error('Empty key');
      }

      this.macMap = {}
      for (let r in this.sysinfo) {
        const item = JSON.parse(this.sysinfo[r])
        this.sysinfo[r] = item
        if (item.mac_address) {
          this.macMap[item.mac_address] = item
        }

        if (item.subnet) {
          this.sysinfo[r].subnetAddress4 = new Address4(item.subnet)
        }
      }

      this.config = Config.getConfig(true)
      if (this.sysinfo['oper'] == null) {
        this.sysinfo.oper = {};
      }
      this.ddns = this.sysinfo["ddns"];
      this.publicIp = this.sysinfo["publicIp"];
      // log.info("System Manager Initialized with Config", this.sysinfo);
    } catch (err) {
      log.error('Error getting sys:network:info', err)
    }

    try {
      this.uuidMap = await rclient.hgetallAsync('sys:network:uuid')

      for (const uuid in this.uuidMap) {
        this.uuidMap[uuid] = JSON.parse(this.uuidMap[uuid]);
      }
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
    return fireRouter.getLogicIntfNames().map(name => this.sysinfo[name]);
  }

  getMonitoringInterfaces() {
    return fireRouter.getMonitoringIntfNames().map(name => this.sysinfo[name])
  }

  getInterface(intf) {
    return this.sysinfo && this.sysinfo[intf]
  }

  getInterfaceViaUUID(uuid) {
    const intf = this.uuidMap && this.uuidMap[uuid]

    return _.isEmpty(intf) ? null :
      Object.assign({}, intf, {
        active: this.getMonitoringInterfaces().some(i => i.uuid == uuid)
      })
  }

  getInterfaceViaIP4(ip) {
    const ipAddress = new Address4(ip)
    return this.getMonitoringInterfaces().find(i => i.subnetAddress4 && ipAddress.isInSubnet(i.subnetAddress4))
  }

  getInterfaceViaIP6(ip6) {
    if (_.isArray(ip6)) {
      for (let index = 0; index < ip6.length; index++) {
        const element = ip6[index];
        const intf = this.getMonitoringInterfaces().find(i => i.name && this.inMySubnet6(element, i.name));
        if (intf) {
          return intf;
        }
      }
    } else {
      return this.getMonitoringInterfaces().find(i => i.name && this.inMySubnet6(ip6, i.name));
    }
  }

  mySignatureMac() {
    return platform.getSignatureMac();
  }

  // this method is not safe as we'll have interfaces with same mac
  // getInterfaceViaMac(mac) {
  //   return this.macMap && this.macMap[mac.toLowerCase()]
  // }


  // DEPRECATING
  monitoringWifiInterface() {
    if (this.config) {
      return this.sysinfo && this.sysinfo[this.config.monitoringWifiInterface];
    }
  }

  getDefaultWanInterface() {
    const wanIntf = fireRouter.getDefaultWanIntfName();
    return wanIntf && this.getInterface(wanIntf);
  }

  myWanIps() {
    const wanIntfs = fireRouter.getWanIntfNames() || [];
    return wanIntfs.map(i => this.getInterface(i)).filter(iface => iface && iface.ip_address).map(i => i.ip_address);
  }

  myDefaultWanIp() {
    const wanIntf = fireRouter.getDefaultWanIntfName();
    if (wanIntf)
      return this.myIp(wanIntf);
    return null;
  }

  myDefaultGateway() {
    const wanIntf = fireRouter.getDefaultWanIntfName();
    if (wanIntf)
      return this.myGateway(wanIntf);
    return null;
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

  isMyIP(ip) {
    if (!ip) return false
    let interfaces = this.getMonitoringInterfaces();
    return interfaces.map(i => i.ip_address === ip).some(Boolean);
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

  myIp2(intf = this.config.monitoringInterface) {
    const if2 = intf + ':0'
    return this.getInterface(if2) && this.getInterface(if2).ip_address;
  }

  // DEPRECATING
  myWifiIp() {
    if (this.monitoringWifiInterface()) {
      return this.monitoringWifiInterface().ip_address;
    } else {
      return undefined;
    }
  }

  // This returns an array
  myIp6(intf = this.config.monitoringInterface) {
    return this.getInterface(intf) && this.getInterface(intf).ip6_addresses;
  }

  isMyIP6(ip6) {
    let interfaces = this.getMonitoringInterfaces();
    return interfaces.map(i => i.ip6_addresses && i.ip6_addresses.includes(ip6)).some(Boolean);
  }

  myIpMask(intf = this.config.monitoringInterface) {
    if (this.getInterface(intf)) {
      let mask = this.getInterface(intf).netmask;
      if (mask.startsWith("Mask:")) {
        mask = mask.substr(5);
      }
      return mask;
    } else {
      return undefined;
    }
  }

  myIpMask2(intf = this.config.monitoringInterface) {
    const if2 = intf + ':0'

    if (this.getInterface(if2)) {
      let mask = this.getInterface(if2).netmask;
      if (mask.startsWith("Mask:")) {
        mask = mask.substr(5);
      }
      return mask;
    } else {
      return undefined;
    }
  }

  isMyMac(mac) {
    if (!mac) return false

    let interfaces = this.getMonitoringInterfaces();
    return interfaces.map(i => i.mac_address && i.mac_address.toUpperCase() === mac.toUpperCase()).some(Boolean);
  }

  myMAC(intf = this.config.monitoringInterface) {
    return this.getInterface(intf)
      && this.getInterface(intf).mac_address
      && this.getInterface(intf).mac_address.toUpperCase();
  }

  myMACViaIP4(ip) {
    const intf = this.getMonitoringInterfaces().find(i => i.ip_address === ip);
    return intf && intf.mac_address && intf.mac_address.toUpperCase();
  }

  myMACViaIP6(ip) {
    const intf = this.getMonitoringInterfaces().find(i => Array.isArray(i.ip6_addresses) && i.ip6_addresses.includes(ip));
    return intf && intf.mac_address && intf.mac_address.toUpperCase();
  }


  // DEPRECATING
  myWifiMAC() {
    if (this.monitoringWifiInterface() && this.monitoringWifiInterface().mac_address) {
      return this.monitoringWifiInterface().mac_address.toUpperCase();
    } else {
      return undefined;
    }
  }

  myDDNS() {
    return this.ddns;
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

  // DEPRECATING
  myWifiSubnet() {
    if (this.monitoringWifiInterface()) {
      return this.monitoringWifiInterface().subnet;
    } else {
      return undefined;
    }
  }

  mySubnetNoSlash(intf) {
    let subnet = this.mySubnet(intf);
    return subnet.substring(0, subnet.indexOf('/'));
  }

  mySSHPassword() {
    return this.sshPassword;
  }

  isOurCloudServer(host) {
    return host === "firewalla.encipher.io";
  }

  inMySubnets4(ip4, intf) {
    ip4 = new Address4(ip4)
    if (!ip4.isValid()) return false;

    let interfaces = this.getMonitoringInterfaces();
    if (intf) {
      interfaces = interfaces.filter(i => i.name === intf)
    }

    return interfaces
      .map(i => i.subnetAddress4 && ip4.isInSubnet(i.subnetAddress4))
      .some(Boolean)
  }

  inMySubnet6(ip6, intf) {
    ip6 = new Address6(ip6)

    if (!ip6.isValid())
      return false;
    else {
      let interfaces = this.getMonitoringInterfaces();
      if (intf) {
        interfaces = interfaces.filter(i => i.name === intf)
      }

      return interfaces
        .map(i => Array.isArray(i.ip6_subnets) &&
          i.ip6_subnets.map(subnet => !subnet.startsWith("fe80:") && ip6.isInSubnet(new Address6(subnet))).some(Boolean) // link local address is not accurate to determine subnet
        ).some(Boolean)
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

  getSysInfo(callback = () => {}) {
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
        serial = await exec("basename \"$(head /proc/1/cgroup)\" | cut -c 1-12").toString().replace(/\n$/, '')
      } else {
        for (let index = 0; index < serialFiles.length; index++) {
          const serialFile = serialFiles[index];
          try {
            serial = fs.readFileSync(serialFile, 'utf8');
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
    let cpuTemperatureList = [ cpuTemperature ]
    if (!f.isDocker() && !f.isTravis()) {
      if (platform.hasMultipleCPUs()) {
        const list = await platform.getCpuTemperature();
        cpuTemperature = list[0]
        cpuTemperatureList = list
      } else {
        cpuTemperature = await platform.getCpuTemperature();
        cpuTemperatureList = [ cpuTemperature ]
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


    const stat = require("../util/Stats.js");
    const memory = await util.promisify(stat.sysmemory)()
    return {
      ip: this.myIp(),
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
      sss: sss.getSysInfo()
    }
  }

  // if the ip is part of our cloud, no need to log it, since it might cost space and memory
  isMyServer(ip) {
    if (this.serverIps) {
      return (this.serverIps.indexOf(ip) > -1);
    }
    return false;
  }

  isMulticastIP4(ip) {
    try {
      if (!new Address4(ip).isValid()) {
        return false;
      }
      if (ip == "255.255.255.255") {
        return true;
      }
      return (iptool.toLong(ip) >= this.multicastlow && iptool.toLong(ip) <= this.multicasthigh)
    } catch (e) {
      log.error("SysManager:isMulticastIP4", ip, e);
      return false;
    }
  }

  isMulticastIP6(ip) {
    return ip.startsWith("ff");
  }

  isMulticastIP(ip) {
    try {
      if (new Address4(ip).isValid()) {
        return this.isMulticastIP4(ip);
      } else {
        return this.isMulticastIP6(ip);
      }
    } catch (e) {
      log.error("SysManager:isMulticastIP", ip, e);
      return false;
    }
  }

  isDNS(ip) {
    if (DNSServers[ip] != null) {
      return true;
    }
    return false;
  }

  // if intf is not specified, check with all interfaces
  isLocalIP(ip, intf) {
    if (!ip) {
      log.warn("SysManager:WARN:isLocalIP empty ip");
      // TODO: we should throw error here
      return false;
    }

    if (new Address4(ip).isValid()) {
      if (this.isMulticastIP4(ip) || ip == '127.0.0.1') {
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
      if (this.locals[ip]) {
        return true;
      }
      return this.inMySubnet6(ip, intf);
    } else {
      log.error("SysManager:ERROR:isLocalIP", ip);
      // TODO: we should throw error here
      return false;
    }
  }

  ipLearned(ip) {
    if (this.locals[ip]) {
      return true;
    } else {
      return false;
    }
  }

  isSystemDomain(ipOrDomain) {
    if (ipOrDomain.indexOf('encipher.io') > -1) {
      return true;
    }
    return false;
  }
}

module.exports = new SysManager();
