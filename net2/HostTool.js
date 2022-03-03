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

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const sysManager = require('./SysManager.js');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const Config = require('./config.js');

const Hashes = require('../util/Hashes.js');

let instance = null;

const maxV6Addr = 8;

const asyncNative = require('../util/asyncNative.js');

const iptool = require('ip');

const {getPreferredBName,getPreferredName} = require('../util/util.js')
const getCanonicalizedDomainname = require('../util/getCanonicalizedURL').getCanonicalizedDomainname;
const firewalla = require('./Firewalla.js');

class HostTool {
  constructor() {
    if(!instance) {
      instance = this;

      this.ipMacMapping = {};
      this.config = Config.getConfig(true);
      setInterval(() => {
        this._flushIPMacMapping();
        this.config = Config.getConfig(true);
      }, 600000); // reset all ip mac mapping once every 10 minutes in case of ip change
    }
    return instance;
  }

  async macExists(mac) {
    const result = await rclient.existsAsync("host:mac:" + mac)
    return result == 1
  }

  async ipv4Exists(ip) {
    const result = await rclient.existsAsync("host:ip4:" + ip)
    return result == 1
  }

  getIPv4Entry(ip) {
    if(!ip)
      return Promise.reject("invalid ip addr");

    let key = "host:ip4:" + ip;
    return rclient.hgetallAsync(key);
  }

  getMACEntry(mac) {
    if(!mac)
      return Promise.reject("invalid mac address");

    return rclient.hgetallAsync(this.getMacKey(mac));
  }

  getHostname(hostEntry) {
    if(hostEntry.name)
      return hostEntry.name;

    if(hostEntry.bname && hostEntry.bname !== "_")
      return hostEntry.bname;

    if(hostEntry.sambaName && hostEntry.sambaName !== "_")
      return hostEntry.sambaName;

    return hostEntry.ipv4;
  }

  async updateDHCPInfo(mac, type, info) {
    let key = "dhcp:" + mac + ":" + type;
    await rclient.hmsetAsync(key, info);
    await rclient.expireAsync(key, 86400);
  }

  updateBackupName(mac, name) {
    log.info("Updating backup name", name, "for mac:", mac);
    let key = "host:mac:" + mac;
    return rclient.hsetAsync(key, "bname", name)
  }

  async updateIPv4Host(host) {
    let uid = host.uid;
    let key = this.getHostKey(uid);

    let hostCopy = JSON.parse(JSON.stringify(host))

    if(hostCopy.ipv6Addr) {
      delete hostCopy.ipv6Addr
    }

    const oldHostMac = await rclient.hgetAsync(key, 'mac')
    // new host taking over this ip, remove previous entry
    if (oldHostMac != host.mac) {
      await rclient.unlinkAsync(key)
    }

    this.cleanupData(hostCopy);
    await rclient.hmsetAsync(key, hostCopy)
    await rclient.expireatAsync(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 30); // auto expire after 30 days
  }

  async updateMACKey(host, skipUpdatingExpireTime) {

    let hostCopy = JSON.parse(JSON.stringify(host))

    if(hostCopy.mac && hostCopy.mac === "00:00:00:00:00:00") {
      log.error("Invalid MAC Address (00:00:00:00:00:00)", new Error().stack);
      //return Promise.reject(new Error("Invalid MAC Address (00:00:00:00:00:00)"));
      return // ignore 00:00:00:00:00:00
    }

    if(hostCopy.ipv6Addr && hostCopy.ipv6Addr.constructor.name === "Array") {
      hostCopy.ipv6Addr = JSON.stringify(hostCopy.ipv6Addr);
    }

    this.cleanupData(hostCopy);

    let key = this.getMacKey(hostCopy.mac);
    await rclient.hmsetAsync(key, hostCopy)

    if(skipUpdatingExpireTime) {
      return;
    } else {
      return rclient.expireatAsync(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 365); // auto expire after 365 days
    }
  }

  updateKeysInMAC(mac, hash) {
    let key = this.getMacKey(mac);

    return rclient.hmsetAsync(key, hash);
  }

  getHostKey(ipv4) {
    return "host:ip4:" + ipv4;
  }

  cleanupData(data) {
    Object.keys(data).forEach((key) => {
      if(data[key] == undefined) {
        delete data[key];
      }
    })
  }

  deleteHost(ip) {
    if (iptool.isV4Format(ip)) {
      return rclient.unlinkAsync(this.getHostKey(ip));
    } else {
      return rclient.unlinkAsync(this.getIPv6HostKey(ip));
    }
  }

  getMacKey(mac) {
    return "host:mac:" + mac;
  }

  deleteMac(mac) {
    return rclient.unlinkAsync(this.getMacKey(mac));
  }

  mergeHosts(oldhost, newhost) {
    let changeset = {};
    for (let i in oldhost) {
      if (newhost[i] != null) {
        if (oldhost[i] != newhost[i]) {
          changeset[i] = newhost[i];
        }
      }
    }
    for (let i in newhost) {
      if (oldhost[i] == null) {
        changeset[i] = newhost[i];
      }
    }
    return changeset;
  }

  async getIPsByMac(mac) {
    let ips = [];
    let macObject = await this.getMACEntry(mac);
    if(!macObject) {
      return ips
    }

    if(macObject.ipv4Addr) {
      ips.push(macObject.ipv4Addr);
    }

    if(macObject.ipv6Addr) {
      let json = macObject.ipv6Addr;
      let ipv6s = JSON.parse(json);
      ips.push.apply(ips, ipv6s);
    }

    return ips;
  }

  async getMacByIP(ip, monitoringOnly = true) {
    let host = null
    if (sysManager.isMyIP(ip, monitoringOnly) || sysManager.isMyIP6(ip, monitoringOnly)) {
      // shortcut for Firewalla's self IP
      const myMac = sysManager.myMACViaIP4(ip) || sysManager.myMACViaIP6(ip);
      if (myMac)
        return myMac;
    }

    if (iptool.isV4Format(ip)) {
      host = await this.getIPv4Entry(ip);
    } else if(iptool.isV6Format(ip)) {
      host = await this.getIPv6Entry(ip);
    } else {
      return null
    }

    return host && host.mac;
  }

  async getMacByIPWithCache(ip, monitoringOnly = true) {
    if (this.ipMacMapping[ip]) {
      return this.ipMacMapping[ip];
    } else {
      const mac = await this.getMacByIP(ip, monitoringOnly);
      if (mac) {
        this.ipMacMapping[ip] = mac;
        return mac;
      } else {
        return null;
      }
    }
  }

  _flushIPMacMapping() {
    this.ipMacMapping = {};
  }

  async getMacEntryByIP(ip) {
    const mac = await this.getMacByIP(ip)
    return this.getMACEntry(mac)
  }

  async getAllMACs() {
    let keys = await rclient.keysAsync("host:mac:*");
    return keys.map(key => key.substring(9)).filter(Boolean);
  }

  async getAllMACEntries() {
    let macKeys = await this.getAllMACs();
    let entries = [];
    for (const mac of macKeys) {
      let entry = await this.getMACEntry(mac);
      entry && entries.push(entry);
    }
    return entries;
  }

  async getAllIPs() {
    let allIPs = [];

    let macKeys = await this.getAllMACs();

    for (const mac of macKeys) {
      let ips = await this.getIPsByMac(mac);
      if (ips) {
        allIPs.push({ips: ips, mac: mac})
      }
    }

    return allIPs;
  }

  updateRecentActivity(mac, activity) {
    if(!activity || !mac) {
      // do nothing if activity or mac is null
      return Promise.resolve()
    }

    if (!this.isMacAddress(mac))
      return;

    let key = this.getMacKey(mac)
    let string = JSON.stringify(activity)

    return rclient.hsetAsync(key, "recentActivity", string)
  }

  async removeDupIPv4FromMacEntry(mac, ip, newMac) {
    // Keep uid for now as it's used as keys in a lot of places
    // TODO: use mac as uid should be a true fix to this

    let macEntry = await this.getMACEntry(mac);
    if (!macEntry) {
      log.error('removeDupIPv4FromMacEntry:', mac, 'not found')
      return Promise.resolve();
    }
    log.info('removeDupIPv4FromMacEntry:', ip, 'old:', mac, 'new:', newMac, macEntry);

    let trans = rclient.multi()

    if (macEntry.ipv4 == ip) trans.hdel(this.getMacKey(mac), "ipv4");
    if (macEntry.ipv4Addr == ip) trans.hdel(this.getMacKey(mac), "ipv4Addr");

    return trans.execAsync()
  }

  ////////////// IPV6 /////////////////////

  getIPv6Entry(ip) {
    if(!ip)
      return Promise.reject("invalid ip addr");

    let key = this.getIPv6HostKey(ip)
    return rclient.hgetallAsync(key);
  }

  getIPv6HostKey(ip) {
    return "host:ip6:" + ip;
  }

  async ipv6Exists(ip) {
    const key = this.getIPv6HostKey(ip)
    const result = await rclient.existsAsync(key)
    return result == 1
  }

  async updateIPv6Host(host, ipv6Addr, skipTimeUpdate) {
    skipTimeUpdate = skipTimeUpdate || false;

    if (!Array.isArray(ipv6Addr)) return

    for (const addr of ipv6Addr) {
      const key = this.getIPv6HostKey(addr)

      const existingData = await rclient.hgetallAsync(key)
      let data = null

      if (existingData && existingData.mac === host.mac) {
        // just update last timestamp for existing device
        if (!skipTimeUpdate) {
          data = {
            lastActiveTimestamp: Date.now() / 1000
          }
        }
      } else {
        await rclient.unlinkAsync(key)
        data = {
          mac: host.mac
        };
        if (!skipTimeUpdate) {
          data.firstFoundTimestamp = Date.now() / 1000;
          data.lastActiveTimestamp = Date.now() / 1000;
        }
      }

      if (data) {
        await rclient.hmsetAsync(key, data)
        await rclient.expireatAsync(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 4)
      }
    }
  }

  ////////////////// END OF IPV6 ////////////////

  //pi@raspbNetworkScan:~/encipher.iot/net2 $ ip -6 neighbor show
  //2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
  // 2601:646:a380:5511:9912:25e1:f991:4cb2 dev eth0 lladdr 00:0c:29:f4:1a:e3 STALE
  // 2601:646:a380:5511:385f:66ff:fe7a:79f0 dev eth0 lladdr 3a:5f:66:7a:79:f0 router STALE
  // 2601:646:9100:74e0:8849:1ba4:352d:919f dev eth0  FAILED  (there are two spaces between eth0 and Failed)

  /*
   * ipv6 differs from ipv4, which it will randomly generate IP addresses, and use them
   * in very short term.  It is pretty hard to detect how long these will be used, so
   * we just hard code max number of ipv6 address
   *
   * we will use 8 for now
   */

  async ipv6Insert(ipv6array, v6addr, unspoof) {
    let removed = ipv6array.splice(maxV6Addr, 1000);
    log.info("V6 Overflow Check: ", ipv6array, v6addr);
    if (v6addr) {
      let oldindex = ipv6array.indexOf(v6addr);
      if (oldindex != -1) {
        ipv6array.splice(oldindex, 1);
      }
      ipv6array.unshift(v6addr);
    }
    log.info("V6 Overflow Check Removed:", removed);

    if (unspoof && removed && removed.length > 0) {
      await asyncNative.eachLimit(removed, 10, async (ip6) => {
        await rclient.sremAsync("monitored_hosts6", ip6)
        log.info("V6 Overflow Removed for real", ip6);
      })
      return removed;
    } else {
      return null
    }
  }

  async linkMacWithIPv6(v6addr, mac, intf) {
    await require('child-process-promise').exec(`ping6 -c 3 -I ${intf} ` + v6addr).catch((err) => {});
    log.info("Discovery:AddV6Host:", v6addr, mac);
    mac = mac.toUpperCase();
    let v6key = "host:ip6:" + v6addr;
    log.debug("============== Discovery:v6Neighbor:Scan", v6key, mac);
    sysManager.setNeighbor(v6addr);
    let ip6Host = await rclient.hgetallAsync(v6key)
    log.debug("-------- Discover:v6Neighbor:Scan:Find", mac, v6addr, ip6Host);
    if (ip6Host != null) {
      ip6Host.mac = mac;
      ip6Host.lastActiveTimestamp = Date.now() / 1000;
    } else {
      ip6Host = {};
      ip6Host.mac = mac;
      ip6Host.lastActiveTimestamp = Date.now() / 1000;
      ip6Host.firstFoundTimestamp = ip6Host.lastActiveTimestamp;
    }
    let result = await rclient.hmsetAsync(v6key, ip6Host)
    log.debug("++++++ Discover:v6Neighbor:Scan:find", result);
    let mackey = "host:mac:" + mac;
    await rclient.expireatAsync(v6key, parseInt((+new Date) / 1000) + 604800); // 7 days
    let macHost = await rclient.hgetallAsync(mackey)
    log.info("============== Discovery:v6Neighbor:Scan:mac", v6key, mac, mackey, macHost);
    if (macHost != null) {
      let ipv6array = [];
      if (macHost.ipv6Addr) {
        ipv6array = JSON.parse(macHost.ipv6Addr);
      }

      // only keep around 5 ipv6 around
      /*
      ipv6array = ipv6array.slice(0,8)
      let oldindex = ipv6array.indexOf(v6addr);
      if (oldindex != -1) {
        ipv6array.splice(oldindex,1);
      }
      ipv6array.unshift(v6addr);
      */
      await this.ipv6Insert(ipv6array, v6addr, true)
      macHost.mac = mac.toUpperCase();
      macHost.ipv6Addr = JSON.stringify(ipv6array);
      macHost.lastActiveTimestamp = Date.now() / 1000;
      log.info("HostTool:Writing macHost:", mackey, macHost);
      await rclient.hmsetAsync(mackey, macHost)
      //v6 at times will discver neighbors that not there ...
      //so we don't update last active here
      //macHost.lastActiveTimestamp = Date.now() / 1000;
    } else {
      macHost = {};
      macHost.mac = mac.toUpperCase();
      macHost.ipv6Addr = JSON.stringify([v6addr]);
      macHost.lastActiveTimestamp = Date.now() / 1000;
      macHost.firstFoundTimestamp = macHost.lastActiveTimestamp;
      log.info("HostTool:Writing macHost:", mackey, macHost);
      await rclient.hmsetAsync(mackey, macHost)
    }

  }

  async getIPv6AddressesByMAC(mac) {
    let key = this.getMacKey(mac)
    let v6String = await rclient.hgetAsync(key, "ipv6Addr")
    if(!v6String) {
      return []
    }

    try {
      let v6Addrs = JSON.parse(v6String)
      return v6Addrs
    } catch(err) {
      log.error(`Failed to parse v6 addrs: ${v6String}`)
      return []
    }
  }

  loadDevicePolicyByMAC(mac) {
    let key = "policy:mac:" + mac;
    return rclient.hgetallAsync(key);
  }

  isMacAddress(mac) {
    const macAddressPattern = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/
    return macAddressPattern.test(mac)
  }

  async getName(ip) {
    if (sysManager.isMyIP(ip, false) || sysManager.isMyIP6(ip, false)) {
      const boxName = (await firewalla.getBoxName()) || "Firewalla";
      return boxName;
    }
    if(sysManager.isLocalIP(ip)) {
      const IdentityManager = require('./IdentityManager.js');
      const identity = IdentityManager.getIdentityByIP(ip);
      if (identity) {
        return identity.getReadableName();
      } else {
        const macEntry = await this.getMacEntryByIP(ip)
        return getPreferredBName(macEntry)
      }
    } else {
      const intelEntry = await intelTool.getIntel(ip)
      return intelEntry && intelEntry.host
    }
  }

  async findMacByMacHash(hash) {
    const allMacs = await this.getAllMACs();
    for(const mac of allMacs) {
      const hashObject = Hashes.getHashObject(mac);
      if(hashObject && hashObject.hash === hash) {
        return mac;
      }
    }

    return null;
  }

  filterOldDevices(hostList) {
    const validHosts = hostList.filter(host => host.o.mac != null)
    const activeHosts = {}
    for (const index in validHosts) {
      const host = validHosts[index]
      const ip = host.o.ipv4Addr
      if(!ip) {
        continue
      }

      if(!activeHosts[ip]) {
        activeHosts[ip] = host
      } else {
        const existingHost = activeHosts[ip]

        // new one is newer
        if(parseFloat(existingHost.lastActiveTimestamp || 0) < parseFloat(host.o.lastActiveTimestamp || 0)) {
          activeHosts[ip] = host
        }
      }
    }

    return Object.values(activeHosts).filter((host, index, array) => array.indexOf(host) == index)
  }

  async generateLocalDomain(mac) {
    if(!this.isMacAddress(mac)) {
      return;
    }
    const macEntry = await this.getMACEntry(mac);
    // customizeDomainName actually specifies hostname, domain corresponds to suffix
    let customizedHostname = macEntry.customizeDomainName;
    let ipv4Addr = macEntry.ipv4Addr;
    let name = getPreferredName(macEntry);
    if (!ipv4Addr || (!name && !customizedHostname)) return;
    name = name && getCanonicalizedDomainname(name.replace(/\s+/g, "."));
    customizedHostname = customizedHostname && getCanonicalizedDomainname(customizedHostname.replace(/\s+/g, "."));
    //const suffix = (await rclient.getAsync('local:domain:suffix')) || '.lan';
    await this.updateMACKey({
      localDomain: name || "",
      userLocalDomain: customizedHostname || "",
      mac: mac
    }, true);
    return {
      localDomain: name,
      userLocalDomain: customizedHostname
    }
  }
}

module.exports = HostTool;
