/*    Copyright 2016-2025 Firewalla Inc.
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
const net = require('net')
const rclient = require('../util/redis_manager.js').getRedisClient()
const Message = require('../net2/Message.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const sysManager = require('./SysManager.js');
const l2 = require('../util/Layer2.js');
const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();
const Hashes = require('../util/Hashes.js');
const f = require('./Firewalla.js');
const Constants = require('./Constants.js');

let instance = null;

const maxV6Addr = 8;

const asyncNative = require('../util/asyncNative.js');

const {getPreferredBName,getPreferredName} = require('../util/util.js')
const firewalla = require('./Firewalla.js');

const LRU = require('lru-cache')
const _ = require('lodash');

class HostTool {
  constructor() {
    if(!instance) {
      instance = this;

      this.ipMacMapping = new LRU({max: 500, maxAge: 600 * 1000});
      sem.on(Message.MSG_MAPPING_IP_MAC_DELETED, (event) => {
        const { ip, mac } = event
        if (ip && mac) {
          if (this.ipMacMapping.peek(ip) == mac)
            this.ipMacMapping.del(ip)
        }
      })

      if (f.isMain()) {
        const Nmap = require('../net2/Nmap.js');
        this.nmap = new Nmap();
      }
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

    const key = this.getHostKey(ip)
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
    let uid = host.ipv4Addr;
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
    const ts = hostCopy.lastActiveTimestamp || hostCopy.firstFoundTimestamp
    if (ts) await rclient.zaddAsync(Constants.REDIS_KEY_hostCopy_ACTIVE, ts, hostCopy.mac)

    if(skipUpdatingExpireTime) {
      return;
    } else {
      return rclient.expireatAsync(key, parseInt((+new Date) / 1000) + 60 * 60 * 24 * 365); // auto expire after 365 days
    }
  }

  async getKeysInMAC(mac, keys) {
    const key = this.getMacKey(mac);
    const data = await rclient.hgetallAsync(key) || {};
    return _.pick(data, keys);
  }

  updateKeysInMAC(mac, hash) {
    let key = this.getMacKey(mac);

    return rclient.hmsetAsync(key, hash);
  }

  deleteKeysInMAC(mac, keys) {
    const key = this.getMacKey(mac);
    return rclient.hdelAsync(key, keys);
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
    if (net.isIPv4(ip)) {
      return rclient.unlinkAsync(this.getHostKey(ip));
    } else {
      return rclient.unlinkAsync(this.getIPv6HostKey(ip));
    }
  }

  getMacKey(mac) {
    return "host:mac:" + mac;
  }

  async deleteMac(mac) {
    await rclient.unlinkAsync(this.getMacKey(mac));
    await rclient.zremAsync(Constants.REDIS_KEY_HOST_ACTIVE, mac)
    return
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

  // not reading host:ip here as it's used DeviceHook for IP change check
  async getMacByIP(ip) {
    const fam = net.isIP(ip)
    if (!fam) return null

    try {
      // shortcut for Firewalla's self IP
      const myMac = fam == 4 ? sysManager.myMACViaIP4(ip) : sysManager.myMACViaIP6(ip);
      if (myMac) return myMac;

      if (fam == 4) {
        return l2.getMACAsync(ip)
      } else if (fam == 6) {
        let mac = await rclient.hgetAsync(this.getIPv6HostKey(ip), 'mac');
        if (mac || sysManager.isLinkLocal(ip, 6)) { // nmap neighbor solicit is not accurate for link-local addresses
          return mac;
        } else {
          mac = await this.nmap.neighborSolicit(ip)
          if (mac && sysManager.isMyMac(mac))
            // should not get neighbor advertisement of Firewalla itself, this is mainly caused by IPv6 spoof
            return null;
          else
            return mac
        }
      }
    } catch(err) {
      log.warn("Not able to find mac address for host:", ip, err);
      return null
    }
  }

  setIPMacCache(ip, mac) {
    this.ipMacMapping.set(ip, mac);
  }

  async getMacByIPWithCache(ip) {
    const cached = this.ipMacMapping.peek(ip)
    if (cached) {
      return cached
    } else {
      const mac = await this.getMacByIP(ip);
      if (mac) {
        this.ipMacMapping.set(ip, mac);
        return mac;
      } else {
        return null;
      }
    }
  }

  async getMacEntryByIP(ip) {
    const mac = await this.getMacByIP(ip)
    return this.getMACEntry(mac)
  }

  async getAllMACs() {
    const MACs = await rclient.zrangeAsync(Constants.REDIS_KEY_HOST_ACTIVE, 0, -1);
    if (MACs.length)
      return MACs.filter(Boolean);
    else {
      // fallback to scan when index is not available yet
      const keys = await rclient.scanResults("host:mac:*");
      return keys.map(key => key.substring(9)).filter(Boolean);
    }
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
    let macEntry = await this.getMACEntry(mac);
    if (!macEntry) {
      log.error('removeDupIPv4FromMacEntry:', mac, 'not found')
      return Promise.resolve();
    }
    log.info('removeDupIPv4FromMacEntry:', ip, 'old:', mac, 'new:', newMac)
    log.verbose(macEntry)

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
      await rclient.zaddAsync(Constants.REDIS_KEY_HOST_ACTIVE, macHost.lastActiveTimestamp, macHost.mac)
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
      await rclient.zaddAsync(Constants.REDIS_KEY_HOST_ACTIVE, macHost.lastActiveTimestamp, macHost.mac)
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

  isPrivateMacAddress(mac) {
    if (!this.isMacAddress(mac))
      return false;
    const firstByte = Number(`0x${mac.substring(0, 2)}`);
    return (firstByte & 0x3) == 2;
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

  // during firemain start and new device discovery, there's a small window that host object is
  // not created in memory thus no tag info.
  async getTags(monitorable, intfUUID) {
    if (!monitorable) return {}

    const transitiveTags = await monitorable.getTransitiveTags()

    const result = {}
    for (const type of Object.keys(Constants.TAG_TYPE_MAP)){
      const flowKey = Constants.TAG_TYPE_MAP[type].flowKey;
      const tags = [];
      if (_.has(transitiveTags, type)) {
        tags.push(...Object.keys(transitiveTags[type]));
        if (intfUUID && intfUUID !== '') {
          const networkProfile = require('./NetworkProfileManager.js').getNetworkProfile(intfUUID);
          if (networkProfile)
            tags.push(... await networkProfile.getTags(type));
        }
      }
      result[flowKey] = _.uniq(tags);
      // remove empty tag key to save memory, this cuts 4%+ from flow:conn
      if (!result[flowKey].length) delete result[flowKey]
    }

    return result
  }
}

module.exports = HostTool;
