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
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

const exec = require('child-process-promise').exec

const spoofer = require('./Spoofer.js');
const sysManager = require('./SysManager.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const routing = require('../extension/routing/routing.js');

const util = require('util')

const f = require('./Firewalla.js');

const getPreferredBName = require('../util/util.js').getPreferredBName

const bone = require("../lib/Bone.js");

const MobileDetect = require('mobile-detect');

const flowUtil = require('../net2/FlowUtil.js');

const linux = require('../util/linux.js');

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()

const VPNClient = require('../extension/vpnclient/VPNClient.js');
const VirtWanGroup = require('./VirtWanGroup.js');

const getCanonicalizedDomainname = require('../util/getCanonicalizedURL').getCanonicalizedDomainname;

const TagManager = require('./TagManager.js');
const Tag = require('./Tag.js');

const ipset = require('./Ipset.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new Dnsmasq();
const _ = require('lodash');
const {Address4, Address6} = require('ip-address');
const LRU = require('lru-cache');

const {Rule} = require('./Iptables.js');

const Monitorable = require('./Monitorable');
const Constants = require('./Constants.js');

const instances = {}; // this instances cache can ensure that Host object for each mac will be created only once.
                      // it is necessary because each object will subscribe HostPolicy:Changed message.
                      // this can guarantee the event handler function is run on the correct and unique object.

const envCreatedMap = {};

class Host extends Monitorable {
  constructor(obj) {
    if (!instances[obj.mac]) {
      super(obj)
      this.callbacks = {};
      if (this.o.ipv4) {
        this.o.ipv4Addr = this.o.ipv4;
      }

      this.ipCache = new LRU({max: 50, maxAge: 150 * 1000}); // IP timeout in lru cache is 150 seconds
      this._mark = false;
      this.o = Host.parse(this.o);
      if (this.o.ipv6Addr) {
        this.ipv6Addr = this.o.ipv6Addr
      }

      // Waiting for IPTABLES_READY event is not necessary here
      // Host object should only be created after initial setup of iptables to avoid racing condition
      if (f.isMain()) (async () => {
        this.spoofing = false;
        sclient.on("message", (channel, message) => {
          this.processNotifications(channel, message);
        });

        if (obj && obj.mac) {
          this.subscribe(this.o.mac, "HostPolicy:Changed");
        }

        await this.predictHostNameUsingUserAgent();

        await Host.ensureCreateDeviceIpset(this.o.mac)
        this.subscribe(this.o.mac, "Device:Updated");
        this.subscribe(this.o.mac, "Device:Delete");
        await this.applyPolicy()
        await this.identifyDevice()
      })().catch(err => {
        log.error(`Error initializing Host ${this.o.mac}`, err);
      })

      this.dnsmasq = new DNSMASQ();
      instances[obj.mac] = this;
      log.info('Created new Host', obj.mac)
    }
    return instances[obj.mac];
  }

  getUniqueId() {
    return this.o.mac
  }

  async update(obj) {
    await super.update(obj)
    if (this.o.ipv4) {
      this.o.ipv4Addr = this.o.ipv4;
    }

    if (f.isMain()) {
      await this.predictHostNameUsingUserAgent();
      await this.loadPolicyAsync();
    }

    this.o = Host.parse(this.o);
    for (const f of Host.metaFieldsJson) {
      this[f] = this.o[f]
    }
  }

  static getIpSetName(mac, af = 4) {
    return `c_${mac}_ip${af}`;
  }

  static getMacSetName(mac) {
    return `c_${mac}_mac_set`;
  }

  static getDeviceSetName(mac) {
    return `c_${mac}_set`;
  }

  static async ensureCreateDeviceIpset(mac) {
    if (envCreatedMap[mac])
      return;
    await exec(`sudo ipset create -! ${Host.getIpSetName(mac, 4)} hash:ip family inet maxelem 10 timeout 900`);
    await exec(`sudo ipset create -! ${Host.getIpSetName(mac, 6)} hash:ip family inet6 maxelem 30 timeout 900`);
    await exec(`sudo ipset create -! ${Host.getMacSetName(mac)} hash:mac maxelem 1`);
    await exec(`sudo ipset add -! ${Host.getMacSetName(mac)} ${mac}`);
    await exec(`sudo ipset create -! ${Host.getDeviceSetName(mac)} list:set`);
    await exec(`sudo ipset add -! ${Host.getDeviceSetName(mac)} ${Host.getMacSetName(mac)}`);
    await exec(`sudo ipset add -! ${Host.getDeviceSetName(mac)} ${Host.getIpSetName(mac, 4)}`);
    await exec(`sudo ipset add -! ${Host.getDeviceSetName(mac)} ${Host.getIpSetName(mac, 6)}`);
    envCreatedMap[mac] = 1;
  }

  async flushIpsets() {
    log.info('Flushing ipset for', this.o.mac)
    await ipset.flush(Host.getIpSetName(this.o.mac, 4))
    await ipset.flush(Host.getIpSetName(this.o.mac, 6))
    await ipset.flush(Host.getMacSetName(this.o.mac))
    await ipset.flush(Host.getDeviceSetName(this.o.mac))
  }

  /* example of ipv6Host
  1) "mac"
  2) "B8:53:AC:5F:99:51"
  3) "firstFoundTimestamp"
  4) "1511599097.786"
  5) "lastActiveTimestamp"
  6) "1511846844.798"

  */

  keepalive() {
    for (let i in this.ipv6Addr) {
      log.debug("keep alive ", this.o.mac,this.ipv6Addr[i]);
      setTimeout(() => {
        linux.ping6(this.ipv6Addr[i]);
      }, (i + 1) * 2000);
    }
    let delay = 10 * 1000;
    if (this.ipv6Addr)
      delay += this.ipv6Addr.length * 2000;
    setTimeout(()=>{
      this.cleanV6();
    }, delay);
  }

  async cleanV6() {
    try {
      if (this.ipv6Addr == null) {
        return;
      }

      let ts = (new Date())/1000;
      let lastActive = 0;
      let _ipv6Hosts = {};

      for (let i in this.ipv6Addr) {
        let ip6 = this.ipv6Addr[i];
        let ip6Host = await rclient.hgetallAsync("host:ip6:"+ip6);
        log.debug("Host:CleanV6:looking up v6",ip6,ip6Host)
        if (ip6Host != null && ip6Host.mac === this.o.mac ) {
          _ipv6Hosts[ip6] = ip6Host;
          if (ip6Host.lastActiveTimestamp > lastActive) {
            lastActive = ip6Host.lastActiveTimestamp;
          }
        }
      }

      this.ipv6Addr = [];
      for (let ip6 in _ipv6Hosts) {
        let ip6Host = _ipv6Hosts[ip6];
        if (ip6Host.lastActiveTimestamp < lastActive - 60*30 || ip6Host.lastActiveTimestamp < ts-60*40) {
          log.info("Host:"+this.o.mac+","+ts+","+ip6Host.lastActiveTimestamp+","+lastActive+" Remove Old Address "+ip6,JSON.stringify(ip6Host));
        } else {
          this.ipv6Addr.push(ip6);
        }
      }

      /* do not update last active time based on ipv6 host entry
      if (this.o.lastActiveTimestamp < lastActive) {
        this.o.lastActiveTimestamp = lastActive;
      }
      */

      log.debug("Host:CleanV6:", this.o.mac, JSON.stringify(this.ipv6Addr));
    } catch(err) {
      log.error("Got error when cleanV6", err)
    }
  }

  async predictHostNameUsingUserAgent() {
    if (this.hasBeenGivenName()) return

    const results = await rclient.smembersAsync("host:user_agent_m:" + this.o.mac)
    if (!results || !results.length) return

    let mobile = false;
    let md_osdb = {};
    let md_name = {};

    for (let i in results) {
      let r = JSON.parse(results[i]);
      if (r.ua) {
        let md = new MobileDetect(r.ua);
        if (md == null) {
          log.info("MD Null");
          continue;
        }
        let name = null;
        if (md.mobile()) {
          mobile = true;
          name = md.mobile();
        }
        let os = md.os();
        if (os != null) {
          if (md_osdb[os]) {
            md_osdb[os] += 1;
          } else {
            md_osdb[os] = 1;
          }
        }
        if (name != null) {
          if (md_name[name]) {
            md_name[name] += 1;
          } else {
            md_name[name] = 1;
          }
        }
      }
    }
    log.debug("Sorting", JSON.stringify(md_name), JSON.stringify(md_osdb))
    let osarray = [];
    let namearray = [];
    for (let i in md_osdb) {
      osarray.push({
        name: i,
        rank: md_osdb[i]
      });
    }
    for (let i in md_name) {
      namearray.push({
        name: i,
        rank: md_name[i]
      });
    }
    osarray.sort(function (a, b) {
      return Number(b.rank) - Number(a.rank);
    })
    namearray.sort(function (a, b) {
      return Number(b.rank) - Number(a.rank);
    })
    if (namearray.length > 0) {
      this.o.ua_name = namearray[0].name;
      this.predictedName = "(?)" + this.o.ua_name;

      if (osarray.length > 0) {
        this.o.ua_os_name = osarray[0].name;
        this.predictedName += "/" + this.o.ua_os_name;
      }
      this.o.pname = this.predictedName;
      log.debug(">>>>>>>>>>>> ", this.predictedName, JSON.stringify(this.o.ua_os_name));
    }
    const toSave = []
    if (mobile == true) {
      this.o.deviceClass = "mobile";
      toSave.push("deviceClass");
    }
    if (this.o.ua_os_name) {
      toSave.push("ua_os_name");
    }
    if (this.o.ua_name) {
      toSave.push("ua_name");
    }
    if (this.o.pname) {
      toSave.push("pname");
    }
    await this.save(toSave)
  }

  hasBeenGivenName() {
    if (this.o.name == null) {
      return false;
    }
    if (this.o.name == this.o.ipv4Addr || this.o.name.indexOf("(?)") != -1 || this.o.name == "undefined") {
      return false;
    }
    return true;
  }

  getMetaKey() {
    return "host:mac:" + this.o.mac
  }

  setScreenTime(screenTime = {}) {
    this.o.screenTime = JSON.stringify(screenTime);
    rclient.hmset("host:mac:" + this.o.mac, {
      'screenTime': this.o.screenTime
    });
  }

  static metaFieldsJson = [ 'ipv6Addr', 'dtype', 'activities' ]

  redisfy() {
    const obj = super.redisfy()

    // TODO: use this.o.ipv6Addr everywhere
    if (this.ipv6Addr) {
      obj.ipv6Addr = JSON.stringify(this.ipv6Addr);
    }
    return obj
  }

  touch(date) {
    if (date != null || date <= this.o.lastActiveTimestamp) {
      return;
    }
    if (date == null) {
      date = Date.now() / 1000;
    }
    this.o.lastActiveTimestamp = date;
    rclient.hmset("host:mac:" + this.o.mac, {
      'lastActiveTimestamp': this.o.lastActiveTimestamp
    });
  }

  getAllIPs() {
    let list = [];
    list.push(this.o.ipv4Addr);
    if (this.ipv6Addr && this.ipv6Addr.length > 0) {
      for (let j in this['ipv6Addr']) {
        list.push(this['ipv6Addr'][j]);
      }
    }
    return list;
  }

  async vpnClient(policy) {
    try {
      const state = policy.state;
      const profileId = policy.profileId;
      const hostConfPath = `${f.getUserConfigFolder()}/dnsmasq/vc_${this.o.mac}.conf`;
      if (this._profileId && profileId !== this._profileId) {
        log.info(`Current VPN profile id is different from the previous profile id ${this._profileId}, remove old rule on ${this.o.mac}`);
        const rule4 = new Rule("mangle").chn("FW_RT_DEVICE_5")
          .mdl("set", `--match-set ${Host.getDeviceSetName(this.o.mac)} src`)
          .jmp(`SET --map-set ${this._profileId.startsWith("VWG:") ? VirtWanGroup.getRouteIpsetName(this._profileId.substring(4)) : VPNClient.getRouteIpsetName(this._profileId)} dst,dst --map-mark`)
          .comment(`policy:mac:${this.o.mac}`);
        const rule6 = rule4.clone().fam(6);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });

        // remove rule that was set by state == null
        rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });
        
        const vcConfPath = `${this._profileId.startsWith("VWG:") ? VirtWanGroup.getDNSRouteConfDir(this._profileId.substring(4)) : VPNClient.getDNSRouteConfDir(this._profileId)}/vc_${this.o.mac}.conf`;
        await fs.unlinkAsync(hostConfPath).catch((err) => {});
        await fs.unlinkAsync(vcConfPath).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }

      this._profileId = profileId;
      if (!profileId) {
        log.warn(`Profile id is not set on ${this.o.mac}`);
        return;
      }
      const rule = new Rule("mangle").chn("FW_RT_DEVICE_5")
          .mdl("set", `--match-set ${Host.getDeviceSetName(this.o.mac)} src`)
          .jmp(`SET --map-set ${profileId.startsWith("VWG:") ? VirtWanGroup.getRouteIpsetName(profileId.substring(4)) : VPNClient.getRouteIpsetName(profileId)} dst,dst --map-mark`)
          .comment(`policy:mac:${this.o.mac}`);

      if (profileId.startsWith("VWG:"))
        await VirtWanGroup.ensureCreateEnforcementEnv(profileId.substring(4));
      else
        await VPNClient.ensureCreateEnforcementEnv(profileId);
      await Host.ensureCreateDeviceIpset(this.o.mac);

      const vcConfPath = `${profileId.startsWith("VWG:") ? VirtWanGroup.getDNSRouteConfDir(profileId.substring(4)) : VPNClient.getDNSRouteConfDir(profileId)}/vc_${this.o.mac}.conf`;
      
      if (state === true) {
        const rule4 = rule.clone();
        const rule6 = rule.clone().fam(6);
        await exec(rule4.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv4 vpn client rule for ${this.o.mac} ${profileId}`, err.message);
        });
        await exec(rule6.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv6 vpn client rule for ${this.o.mac} ${profileId}`, err.message);
        });

        // remove rule that was set by state == null
        rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });
        const markTag = `${profileId.startsWith("VWG:") ? VirtWanGroup.getDnsMarkTag(profileId.substring(4)) : VPNClient.getDnsMarkTag(profileId)}`;
        // use two config files, one in network directory, the other in vpn client hard route directory, the second file is controlled by conf-dir in VPNClient.js and will not be included when client is disconnected
        await fs.writeFileAsync(hostConfPath, `mac-address-tag=%${this.o.mac}$vc_${this.o.mac}`).catch((err) => {});
        await fs.writeFileAsync(vcConfPath, `tag-tag=$vc_${this.o.mac}$${markTag}$!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // null means off
      if (state === null) {
        // remove rule that was set by state == true
        const rule4 = rule.clone();
        const rule6 = rule.clone().fam(6);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });
        // override target and clear vpn client bits in fwmark
        rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(rule4.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv4 vpn client rule for ${this.o.mac} ${profileId}`, err.message);
        });
        await exec(rule6.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv6 vpn client rule for ${this.o.mac} ${profileId}`, err.message);
        });
        await fs.writeFileAsync(hostConfPath, `mac-address-tag=%${this.o.mac}$vc_${this.o.mac}`).catch((err) => {});
        await fs.writeFileAsync(vcConfPath, `tag-tag=$vc_${this.o.mac}$${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // false means N/A
      if (state === false) {
        const rule4 = rule.clone();
        const rule6 = rule.clone().fam(6);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.mac} ${profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.mac} ${profileId}`, err.message);
        });

        // remove rule that was set by state == null
        rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.mac} ${this._profileId}`, err.message);
        });
        await fs.unlinkAsync(hostConfPath).catch((err) => {});
        await fs.unlinkAsync(vcConfPath).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
    } catch (err) {
      log.error("Failed to set VPN client access on " + this.o.mac);
    }
  }

  async _dnsmasq(policy) {
    try {
      const dnsCaching = policy.dnsCaching;
      if (dnsCaching === true) {
        const cmd = `sudo ipset del -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST_MAC} ${this.o.mac}`;
        await exec(cmd);
      } else {
        const cmd = `sudo ipset add -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST_MAC} ${this.o.mac}`;
        await exec(cmd);
      }
    } catch (err) {
      log.error("Failed to set dnsmasq policy on " + this.o.mac, err);
    }
  }

  async ipAllocation(policy) {
    // to ensure policy set by different client won't conflict each other.
    // delete fields in host:mac for all versions
    await rclient.hdelAsync("host:mac:" + this.o.mac, "intfIp");
    await rclient.hdelAsync("host:mac:" + this.o.mac, "staticAltIp");
    await rclient.hdelAsync("host:mac:" + this.o.mac, "staticSecIp");
    await rclient.hdelAsync("host:mac:" + this.o.mac, "dhcpIgnore");

    if (policy.dhcpIgnore === true) {
      await rclient.hsetAsync("host:mac:" + this.o.mac, "dhcpIgnore", "true");
    }

    if (policy.allocations) {
      const intfIp = {}
      for (const uuid of Object.keys(policy.allocations)) {
        const allocation = policy.allocations[uuid]
        if (allocation.type == 'static') {
          intfIp[uuid] = {
            ipv4: allocation.ipv4
          }
        }
      }
      await rclient.hsetAsync("host:mac:" + this.o.mac, "intfIp", JSON.stringify(intfIp));
    }
    else if (policy.type) {
      const type = policy.type;

      if (type === "dynamic") {
        // nothing to do now
      }
      else if (type === "static") {
        // Red/Blue
        const alternativeIp = policy.alternativeIp;
        const secondaryIp = policy.secondaryIp;
        if (alternativeIp)
          await rclient.hsetAsync("host:mac:" + this.o.mac, "staticAltIp", alternativeIp);
        if (secondaryIp)
          await rclient.hsetAsync("host:mac:" + this.o.mac, "staticSecIp", secondaryIp);
      }
    }

    this.dnsmasq.onDHCPReservationChanged();
  }

  isMonitoring() {
    // this.spoofing should be changed immediately when spoof state is changed
    return this.spoofing;
  }

  async qos(state) {
    if (state === true) {
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF_MAC} ${this.o.mac}`).catch((err) => {
        log.error(`Failed to remove ${this.o.mac} from ${ipset.CONSTANTS.IPSET_QOS_OFF_MAC}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {
        log.error(`Failed to remove ${Host.getIpSetName(this.o.mac, 4)} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {
        log.error(`Failed to remove ${Host.getIpSetName(this.o.mac, 6)} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    } else {
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF_MAC} ${this.o.mac}`).catch((err) => {
        log.error(`Failed to add ${this.o.mac} to ${ipset.CONSTANTS.IPSET_QOS_OFF_MAC}`, err);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {
        log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 4)} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {
        log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 6)} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    }
  }

  async acl(state) {
    if (state === true) {
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF_MAC} ${this.o.mac}`).catch((err) => {
        log.error(`Failed to remove ${this.o.mac} from ${ipset.CONSTANTS.IPSET_ACL_OFF_MAC}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {
        log.error(`Failed to remove ${Host.getIpSetName(this.o.mac, 4)} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {
        log.error(`Failed to remove ${Host.getIpSetName(this.o.mac, 6)} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    } else {
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF_MAC} ${this.o.mac}`).catch((err) => {
        log.error(`Failed to add ${this.o.mac} to ${ipset.CONSTANTS.IPSET_ACL_OFF_MAC}`, err);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {
        log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 4)} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {
        log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 6)} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    }
  }

  async spoof(state) {
    log.debug("Spoofing ", this.o.ipv4Addr, this.ipv6Addr, this.o.mac, state, this.spoofing);
    if (this.spoofing != state) {
      log.info(`Host:Spoof: ${this.o.name}, ${this.o.mac},`
        + ` current spoof state: ${this.spoofing}, new spoof state: ${state}`)
    }
    // set spoofing data in redis and trigger dnsmasq reload hosts
    if (state === true) {
      await rclient.hmsetAsync("host:mac:" + this.o.mac, 'spoofing', true, 'spoofingTime', new Date() / 1000)
        .catch(err => log.error("Unable to set spoofing in redis", err))
        .then(() => this.dnsmasq.onSpoofChanged());
      this.spoofing = state;
    } else {
      await rclient.hmsetAsync("host:mac:" + this.o.mac, 'spoofing', false, 'unspoofingTime', new Date() / 1000)
        .catch(err => log.error("Unable to set spoofing in redis", err))
        .then(() => this.dnsmasq.onSpoofChanged());
      this.spoofing = false;
    }

    if (this.o.ipv4Addr == null) {
      log.info("Host:Spoof:NoIP", this.o);
      return;
    }

    const iface = _.isString(this.o.ipv4Addr) && sysManager.getInterfaceViaIP(this.o.ipv4Addr);
    if (!iface || !iface.name) {
      log.info(`Network interface name is not defined for ${this.o.ipv4Addr}`);
      return;
    }
    if (iface.type !== "wan" || !sysManager.myGateway(iface.name)) {
      // a relative tight condition to check if it is a WAN interface
      log.debug(`${iface.name} is not a WAN interface, no need to spoof ${this.o.ipv4Addr} ${this.o.mac}`);
      return;
    }
    const gateway = sysManager.myGateway(iface.name);
    const gateway6 = sysManager.myGateway6(iface.name);

    if (this.o.ipv4Addr === gateway || this.o.mac == null || sysManager.isMyIP(this.o.ipv4Addr)) {
      return;
    }

    if (this.o.mac == "00:00:00:00:00:00" || this.o.mac.indexOf("00:00:00:00:00:00")>-1) {
      return;
    }
    if (this.o.mac == "FF:FF:FF:FF:FF:FF" || this.o.mac.indexOf("FF:FF:FF:FF:FF:FF")>-1) {
      return;
    }
    if(state === true) {
      hostTool.getMacByIP(gateway).then((gatewayMac) => {
        if (gatewayMac && gatewayMac === this.o.mac) {
          // ignore devices that has same mac address as gateway
          log.info(this.o.ipv4Addr + " has same mac address as gateway. Skip spoofing...");
          return;
        }
        spoofer.newSpoof(this.o.ipv4Addr, iface.name)
          .then(() => {
            log.debug("Started spoofing", this.o.ipv4Addr, this.o.mac, this.o.name);
          }).catch((err) => {
            log.error("Failed to spoof", this.o.ipv4Addr, this.o.mac, this.o.name, err);
          })
      })
    } else {
      spoofer.newUnspoof(this.o.ipv4Addr, iface.name)
        .then(() => {
          log.debug("Stopped spoofing", this.o.ipv4Addr, this.o.mac, this.o.name);
        }).catch((err) => {
          log.error("Failed to unspoof", this.o.ipv4Addr, this.o.mac, this.o.name, err);
        })
    }

    /* put a safety on the spoof */
    log.debug("Spoof For IPv6",this.o.mac, JSON.stringify(this.ipv6Addr),JSON.stringify(this.o.ipv6Addr));
    if (this.ipv6Addr && this.ipv6Addr.length>0) {
      for (let i in this.ipv6Addr) {
        if (this.ipv6Addr[i] == gateway6) {
          continue;
        }
        if (sysManager.isMyIP6(this.ipv6Addr[i])) {
          continue;
        }
        if (state == true) {
          spoofer.newSpoof6(this.ipv6Addr[i], iface.name).then(()=>{
            log.debug("Started v6 spoofing", this.ipv6Addr[i]);
          }).catch((err)=>{
            log.error("Failed to spoof", this.ipv6Addr, err);
          })
          if (i>20) {
            log.error("Failed to Spoof, over ",i, " of ", this.ipv6Addr);
            break;
          }
        } else {
          spoofer.newUnspoof6(this.ipv6Addr[i], iface.name).then(()=>{
            log.debug("Stopped v6 spoofing", this.ipv6Addr[i]);
          }).catch((err)=>{
            log.error("Failed to [v6] unspoof", this.ipv6Addr, err);
          })
        }
      }
    }
  }

  async shield(policy) {
  }

  // Notice
  processNotifications(channel, message) {
    if (channel.toLowerCase().indexOf("notice") >= 0) {
      if (this.callbacks.notice != null) {
    log.debug("RX Notifcaitons", channel, message);
        this.callbacks.notice(this, channel, message);
      }
    }
  }

  /*
    {"ts":1466353908.736661,"uid":"CYnvWc3enJjQC9w5y2","id.orig_h":"192.168.2.153","id.orig_p":58515,"id.resp_h":"98.124.243.43","id.resp_p":80,"seen.indicator":"streamhd24.com","seen
    .indicator_type":"Intel::DOMAIN","seen.where":"HTTP::IN_HOST_HEADER","seen.node":"bro","sources":["from http://spam404bl.com/spam404scamlist.txt via intel.criticalstack.com"]}
    */
  subscribe(mac, e) {
    this.subscriber.subscribeOnce("DiscoveryEvent", e, mac, async (channel, type, ip, obj) => {
      log.debug("Host:Subscriber", channel, type, ip, obj);
      if (type === "HostPolicy:Changed" && f.isMain()) {
        this.scheduleApplyPolicy();
        log.info("HostPolicy:Changed", channel, mac, ip, type, obj);
      } else if (type === "Device:Updated" && f.isMain()) {
        // Most policies are iptables based, change device related ipset should be good enough, to update
        // policies that leverage mechanism other than iptables, should register handler within its own domain
        this.scheduleUpdateHostData();
      } else if (type === "Device:Delete") {
        log.info('Deleting Host', this.o.mac)
        this.subscriber.unsubscribe('DiscoveryEvent', 'HostPolicy:Changed', this.o.mac);
        this.subscriber.unsubscribe('DiscoveryEvent', 'Device:Updated',     this.o.mac);
        this.subscriber.unsubscribe('DiscoveryEvent', 'Device:Delete',      this.o.mac);

        if (f.isMain()) {
          // this effectively stops all iptables rules against this device
          // PolicyManager2 should be dealing with iptables entries alone
          await this.flushIpsets();

          await this.resetPolicies()

          // delete redis host keys
          if (this.o.ipv4Addr) {
            await rclient.unlinkAsync(`host:ip4:${this.o.ipv4Addr}`)
          }
          if (Array.isArray(this.ipv6Addr) && this.ipv6Addr.length) {
            await rclient.unlinkAsync(this.ipv6Addr.map(ip6 => `host:ip6:${ip6}`))
          }
          await rclient.unlinkAsync(`host:mac:${mac}`)
        }

        this.ipCache.reset();
        delete envCreatedMap[this.o.mac];
        delete instances[this.o.mac]
      }
    });
  }

  scheduleUpdateHostData() {
    if (this.updateHostDataTask)
      clearTimeout(this.updateHostDataTask);
    this.updateHostDataTask = setTimeout(async () => {
      try {
        // update tracking ipset
        const macEntry = await hostTool.getMACEntry(this.o.mac);
        const ipv4Addr = macEntry && macEntry.ipv4Addr;
        if (ipv4Addr) {
          const recentlyAdded = this.ipCache.get(ipv4Addr);
          if (!recentlyAdded) {
            await exec(`sudo ipset -exist add -! ${Host.getIpSetName(this.o.mac, 4)} ${ipv4Addr}`).catch((err) => {
              log.error(`Failed to add ${ipv4Addr} to ${Host.getIpSetName(this.o.mac, 4)}`, err.message);
            });
            this.ipCache.set(ipv4Addr, 1);
          }
        }
        let ipv6Addr = null;
        ipv6Addr = macEntry && macEntry.ipv6Addr && JSON.parse(macEntry.ipv6Addr);
        if (Array.isArray(ipv6Addr)) {
          for (const addr of ipv6Addr) {
            const recentlyAdded = this.ipCache.get(addr);
            if (!recentlyAdded) {
              await exec(`sudo ipset -exist add -! ${Host.getIpSetName(this.o.mac, 6)} ${addr}`).catch((err) => {
                log.error(`Failed to add ${addr} to ${Host.getIpSetName(this.o.mac, 6)}`, err.message);
              });
              this.ipCache.set(addr, 1);
            }
          }
        }
        await this.updateHostsFile();
      } catch (err) {
        log.error('Error update host data', err)
      }
    }, 3000);
  }

  async updateHostsFile() {
    const macEntry = await hostTool.getMACEntry(this.o.mac);
    // update hosts file in dnsmasq
    const hostsFile = Host.getHostsFilePath(this.o.mac);
    const lastActiveTimestamp = Number((macEntry && macEntry.lastActiveTimestamp) || 0);
    if (!macEntry || Date.now() / 1000 - lastActiveTimestamp > 1800) {
      // remove hosts file if it is not active in the last 30 minutes or it is already removed from host:mac:*
      if (this._lastHostfileEntries !== null) {
        await fs.unlinkAsync(hostsFile).catch((err) => { });
        dnsmasq.scheduleReloadDNSService();
        this._lastHostfileEntries = null;
      }
      return;
    }
    const ipv4Addr = macEntry && macEntry.ipv4Addr;
    const suffix = await rclient.getAsync(Constants.REDIS_KEY_LOCAL_DOMAIN_SUFFIX) || "lan";
    const localDomain = macEntry.localDomain || "";
    const userLocalDomain = macEntry.userLocalDomain || "";
    if (!ipv4Addr) {
      if (this._lastHostfileEntries !== null) {
        await fs.unlinkAsync(hostsFile).catch((err) => { });
        dnsmasq.scheduleReloadDNSService();
        this._lastHostfileEntries = null;
      }
      return;
    }
    let ipv6Addr = null;
    try {
      ipv6Addr = macEntry && macEntry.ipv6Addr && JSON.parse(macEntry.ipv6Addr);
    } catch (err) {}
    const aliases = [userLocalDomain, localDomain].filter((d) => d.length !== 0).map(s => getCanonicalizedDomainname(s.replace(/\s+/g, "."))).filter((v, i, a) => {
      return a.indexOf(v) === i;
    })
    const iface = sysManager.getInterfaceViaIP(ipv4Addr);
    if (!iface) {
      if (this._lastHostfileEntries !== null) {
        await fs.unlinkAsync(hostsFile).catch((err) => { });
        dnsmasq.scheduleReloadDNSService();
        this._lastHostfileEntries = null;
      }
      return;
    }
    const suffixes = (iface.searchDomains || []).concat([suffix]).map(s => getCanonicalizedDomainname(s.replace(/\s+/g, "."))).filter((v, i, a) => {
      return a.indexOf(v) === i;
    });
    const entries = [];
    for (const suffix of suffixes) {
      for (const alias of aliases) {
        const fqdn = `${alias}.${suffix}`;
        if (new Address4(ipv4Addr).isValid())
          entries.push(`${ipv4Addr} ${fqdn}`);
        let ipv6Found = false;
        if (_.isArray(ipv6Addr)) {
          for (const addr of ipv6Addr) {
            const addr6 = new Address6(addr);
            if (addr6.isValid() && !addr6.isLinkLocal()) {
              ipv6Found = true;
              entries.push(`${addr} ${fqdn}`);
            }
          }
        }
        // add empty ipv6 address if no routable ipv6 address is available
        if (!ipv6Found)
          entries.push(`:: ${fqdn}`);
      }
    }
    if (entries.length !== 0) {
      if (this._lastHostfileEntries !== entries.sort().join("\n")) {
        await fs.writeFileAsync(hostsFile, entries.join("\n")).catch((err) => {
          log.error(`Failed to write hosts file ${hostsFile}`, err.message);
        });
        dnsmasq.scheduleReloadDNSService();
        this._lastHostfileEntries = entries.sort().join("\n");
      }
    } else {
      if (this._lastHostfileEntries !== null) {
        await fs.unlinkAsync(hostsFile).catch((err) => { });
        dnsmasq.scheduleReloadDNSService();
        this._lastHostfileEntries = null;
      }
    }
    this.scheduleInvalidateHostsFile();
  }

  scheduleInvalidateHostsFile() {
    if (this.invalidateHostsFileTask)
      clearTimeout(this.invalidateHostsFileTask);
    this.invalidateHostsFileTask = setTimeout(() => {
      const hostsFile = Host.getHostsFilePath(this.o.mac);
      log.info(`Host ${this.o.mac} remains inactive for 30 minutes, removing hosts file ${hostsFile} ...`);
      fs.unlinkAsync(hostsFile).then(() => {
        dnsmasq.scheduleReloadDNSService();
        this._lastHostfileEntries = null;
      }).catch((err) => {});
    }, 1800 * 1000);
  }

  static getHostsFilePath(mac) {
    return `${f.getRuntimeInfoFolder()}/hosts/${mac}`;
  }

  async applyPolicy() {
    try {
      await this.loadPolicyAsync()
      log.debug("HostPolicy:Loaded", JSON.stringify(this.policy));
      const policy = JSON.parse(JSON.stringify(this.policy));

      const policyManager = require('./PolicyManager.js');
      await policyManager.executeAsync(this, this.o.ipv4Addr, policy)
    } catch(err) {
      log.error('Failed to apply host policy', this.o.mac, this.policy, err)
    }
  }

  async resetPolicies() {
    // don't use setPolicy() here as event listener has been unsubscribed
    const defaultPolicy = {
      tags: [],
      vpnClient: {state: false},
      acl: true,
      dnsmasq: {dnsCaching: true},
      device_service_scan: false,
      adblock: false,
      safeSearch: {state: false},
      family: false,
      unbound: {state: false},
      doh: {state: false},
      monitor: true
    };
    const policy = {};
    // override keys in this.policy with default value
    for (const key of Object.keys(this.policy)) {
      if (defaultPolicy.hasOwnProperty(key))
        policy[key] = defaultPolicy[key];
      else
        policy[key] = this.policy[key];
    }
    const policyManager = require('./PolicyManager.js');
    await policyManager.executeAsync(this, this.o.ipv4Addr, policy);

    this.subscriber.publish("FeaturePolicy", "Extension:PortForwarding", null, {
      "applyToAll": "*",
      "wanUUID": "*",
      "extIP": "*",
      "toPort": "*",
      "protocol": "*",
      "toMac": this.o.mac,
      "_type": "*",
      "state": false,
      "dport": "*"
    })

    await rclient.unlinkAsync('policy:mac:' + this.o.mac);
  }

  // type:
  //  { 'human': 0-100
  //    'type': 'Phone','desktop','server','thing'
  //    'subtype: 'ipad', 'iphone', 'nest'
  //
  async calculateDType() {
    let results = await rclient.smembersAsync("host:user_agent:" + this.o.ipv4Addr);
    if (!results) return null

    let human = results.length / 100.0;
    this.o.dtype = {
      'human': human
    }
    await this.save('dtype')
    return this.o.dtype
  }

  /*
    {
       deviceClass: mobile, thing, computer, other, unknown
       human: score
    }
    */
  /* produce following
   *
   * .o._identifyExpiration : time stamp
   * .o._devicePhoto: "http of photo"
   * .o._devicePolicy: <future>
   * .o._deviceType:
   * .o._deviceClass:
   *
   * this is for device identification only.
   */

  packageTopNeighbors(count, callback) {
    let nkey = "neighbor:"+this.o.mac;
    rclient.hgetall(nkey,(err,neighbors)=> {
      if (neighbors) {
        let neighborArray = [];
        for (let i in neighbors) {
          try {
            let obj = JSON.parse(neighbors[i]);
            obj['ip'] = i;
            neighborArray.push(obj);
            count--;
          } catch (e) {
            log.warn('parse neighbor data error', neighbors[i], nkey);
          }
        }
        neighborArray.sort(function (a, b) {
          return Number(b.count) - Number(a.count);
        })
        callback(err, neighborArray.slice(0,count));
      } else {
        callback(err, null);
      }
    });

  }

  //'17.249.9.246': '{"neighbor":"17.249.9.246","cts":1481259330.564,"ts":1482050353.467,"count":348,"rb":1816075,"ob":1307870,"du":10285.943863000004,"name":"api-glb-sjc.smoot.apple.com"}


  hashNeighbors(neighbors) {
    let _neighbors = JSON.parse(JSON.stringify(neighbors));
    let debug =  sysManager.isSystemDebugOn() || !f.isProduction();
    for (let i in _neighbors) {
      let neighbor = _neighbors[i];
      neighbor._neighbor = flowUtil.hashIp(neighbor.neighbor);
      neighbor._name = flowUtil.hashIp(neighbor.name);
      if (debug == false) {
        delete neighbor.neighbor;
        delete neighbor.name;
        delete neighbor.ip;
      }
    }

    return _neighbors;
  }

  async identifyDevice(force) {
    if (!f.isMain()) {
      return;
    }
    if (!force && this.o._identifyExpiration != null && this.o._identifyExpiration > Date.now() / 1000) {
      log.silly("HOST:IDENTIFY too early", this.o.mac, this.o._identifyExpiration);
      return;
    }
    log.info("HOST:IDENTIFY",this.o.mac);
    // need to have if condition, not sending too much info if the device is ...
    // this may be used initially _identifyExpiration

    await this.calculateDType();

    let obj = {
      deviceClass: 'unknown',
      human: this.o.dtype,
      vendor: this.o.macVendor,
      ou: this.o.mac.slice(0,13),
      uuid: flowUtil.hashMac(this.o.mac),
      _ipv4: flowUtil.hashIp(this.o.ipv4),
      ipv4: this.o.ipv4,
      firstFoundTimestamp: this.o.firstFoundTimestamp,
      lastActiveTimestamp: this.o.lastActiveTimestamp,
      bonjourName: this.o.bonjourName,
      dhcpName: this.o.dhcpName,
      ssdpName: this.o.ssdpName,
      bname: this.o.bname,
      pname: this.o.pname,
      ua_name : this.o.ua_name,
      ua_os_name : this.o.ua_os_name,
      name : this.name(),
      monitored: this.policy['monitor'],
      vpnClient: this.policy['vpnClient']
    };

    // Do not pass vendor info to cloud if vendor is unknown, this can force cloud to validate vendor oui info again.
    if(this.o.macVendor === 'Unknown') {
      delete obj.vendor;
    }

    if (this.o.deviceClass == "mobile") {
      obj.deviceClass = "mobile";
    }
    try {
      obj.flowInCount = await rclient.zcountAsync("flow:conn:in:" + this.o.mac, "-inf", "+inf");
      obj.flowOutCount = await rclient.zcountAsync("flow:conn:out:" + this.o.mac, "-inf", "+inf");

      let neighbors = await util.promisify(this.packageTopNeighbors).bind(this)(60)
      if (neighbors) {
        obj.neighbors = this.hashNeighbors(neighbors);
      }
      let results = await rclient.smembersAsync("host:user_agent:" + this.o.ipv4Addr)

      if (!results) return obj;
      if (this.ipv6Addr) {
        obj.ipv6Addr = this.ipv6Addr.filter(currentIp => !currentIp.startsWith("fe80::"));
      }
      obj.agents = results;

      // assign policy values just before request to give it enough time to load policy from constructor
      obj.monitored = this.policy.monitor
      obj.vpnClient = this.policy.vpnClient

      let data = await bone.deviceAsync("identify", obj)
      if (data != null) {
        log.debug("HOST:IDENTIFY:RESULT", this.name(), data);

        // pretty much set everything from cloud to local
        // _identifyExpiration is set here
        for (let field in data) {
          let value = data[field]
          if(value.constructor.name === 'Array' ||
            value.constructor.name === 'Object') {
            this.o[field] = JSON.stringify(value)
          } else {
            this.o[field] = value
          }
        }

        if (data._vendor!=null && (this.o.macVendor == null || this.o.macVendor === 'Unknown')) {
          this.o.macVendor = data._vendor;
        }
        if (data._name!=null) {
          this.o.pname = data._name;
        }
        if (data._deviceType) {
          this.o._deviceType = data._deviceType
        }
        await this.save();
      }

    } catch (e) {
      log.error("HOST:IDENTIFY:ERROR", obj, e);
    }
    return obj;
  }

  clean() {
    this.callbacks = {};
  }

  on(event, callback) {
    this.callbacks[event] = callback;
  }

  name() {
    return this.getReadableName()
  }

  getReadableName() {
    return getPreferredBName(this.o) || super.getReadableName()
  }

  toShortString() {
    let name = this.name();
    if (name == null) {
      name = "unknown";
    }
    let ip = this.o.ipv4Addr;

    let now = Date.now() / 1000;
    return ip + "\t" + name + " (" + Math.ceil((now - this.o.lastActiveTimestamp || 0) / 60) + "m)" + " " + this.o.mac;
  }

  getNameCandidates() {
    let names = []

    if(this.o.cloudName) {
      names.push(this.o.cloudName);
    }

    if(this.o.dhcpName) {
      names.push(this.o.dhcpName)
    }

    if(this.o.nmapName) {
      names.push(this.o.nmapName)
    }

    if(this.o.bonjourName) {
      names.push(this.o.bonjourName)
    }

    if(this.o.ssdpName) {
      names.push(this.o.ssdpName)
    }

    if(this.o.bname) {
      names.push(this.o.bname)
    }

    return names.filter((value, index, self) => self.indexOf(value) === index)
  }

  toJson() {
    let json = {
      dtype: this.o.dtype,
      ip: this.o.ipv4Addr,
      ipv6: this.ipv6Addr,
      mac: this.o.mac,
      lastActive: this.o.lastActiveTimestamp,
      firstFound: this.o.firstFoundTimestamp,
      macVendor: this.o.macVendor,
      recentActivity: this.o.recentActivity,
      manualSpoof: this.o.manualSpoof,
      dhcpName: this.o.dhcpName,
      bonjourName: this.o.bonjourName,
      nmapName: this.o.nmapName,
      ssdpName: this.o.ssdpName,
      userLocalDomain: this.o.userLocalDomain,
      localDomain: this.o.localDomain,
      intf: this.o.intf ? this.o.intf : 'Unknown',
      stpPort: this.o.stpPort
    }

    if (this.o.ipv4Addr == null) {
      json.ip = this.o.ipv4;
    }

    const preferredBName = getPreferredBName(this.o)

    if (preferredBName) {
      json.bname = preferredBName
    }

    json.names = this.getNameCandidates()

    if (this.o.activities) {
      json.activities= this.o.activities;
    }

    if (this.o.name) {
      json.name = this.o.name;
    }

    if (this.o._deviceType) {
      json._deviceType = this.o._deviceType
    }

    if (this.o._deviceType_p) {
      json._deviceType_p = this.o._deviceType_p
    }

    if (this.o._deviceType_top3) {
      try {
        json._deviceType_top3 = JSON.parse(this.o._deviceType_top3)
      } catch(err) {
        log.error("Failed to parse device type top 3 info:", err)
      }
    }

    if(this.o.modelName) {
      json.modelName = this.o.modelName
    }

    if(this.o.manufacturer) {
      json.manufacturer = this.o.manufacturer
    }

    if (this.hostname) {
      json._hostname = this.hostname
    }
    if (this.policy) {
      json.policy = this.policy;

      if (this.policy.tags) {
        json.tags = this.policy.tags
      }
    }
    if (this.flowsummary) {
      json.flowsummary = this.flowsummary;
    }

    if(this.o.openports) {
      try {
        json.openports = JSON.parse(this.o.openports);
      } catch(err) {
        log.error("Failed to parse openports:", err);
      }
    }
    if (this.o.screenTime) {
      try {
        json.screenTime = JSON.parse(this.o.screenTime);
      } catch (err) {
        log.error("Failed to parse screenTime:", err);
      }
    }

    // json.macVendor = this.name();

    return json;
  }

  _getPolicyKey() {
    return `policy:mac:${this.getUniqueId()}`;
  }

  policyToString() {
    if (this.policy == null || Object.keys(this.policy).length == 0) {
      return "No policy defined";
    } else {
      let msg = "";
      for (let k in this.policy) {
        msg += k + " : " + this.policy[k] + "\n";
      }
      return msg;
    }
  }

  async getVpnClientProfileId() {
    if (!this.policy)
      await this.loadPolicyAsync();
    if (this.policy.vpnClient) {
      if (this.policy.vpnClient.state === true && this.policy.vpnClient.profileId)
        return this.policy.vpnClient.profileId;
    }
    return null;
  }

  async getTags() {
    if (!this.policy) await this.loadPolicyAsync()

    return this.policy.tags && this.policy.tags.map(String) || [];
  }

  async tags(tags) {
    tags = (tags || []).map(String);
    this._tags = this._tags || [];
    if (!this.o || !this.o.mac) {
      log.error(`Mac address is not defined`);
      return;
    }
    // remove old tags that are not in updated tags
    const removedTags = this._tags.filter(uid => !tags.includes(uid));
    for (let removedTag of removedTags) {
      const tag = TagManager.getTagByUid(removedTag);
      if (tag) {
        await Tag.ensureCreateEnforcementEnv(removedTag);
        await exec(`sudo ipset del -! ${Tag.getTagDeviceMacSetName(removedTag)} ${this.o.mac}`).catch((err) => {});
        await exec(`sudo ipset del -! ${Tag.getTagSetName(removedTag)} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {});
        await exec(`sudo ipset del -! ${Tag.getTagSetName(removedTag)} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {});
        await exec(`sudo ipset del -! ${Tag.getTagDeviceSetName(removedTag)} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {});
        await exec(`sudo ipset del -! ${Tag.getTagDeviceSetName(removedTag)} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {});
        await fs.unlinkAsync(`${f.getUserConfigFolder()}/dnsmasq/tag_${removedTag}_${this.o.mac.toUpperCase()}.conf`).catch((err) => {});
      } else {
        log.warn(`Tag ${removedTag} not found`);
      }
    }
    // filter updated tags in case some tag is already deleted from system
    const updatedTags = [];
    for (let uid of tags) {
      const tag = TagManager.getTagByUid(uid);
      if (tag) {
        await Tag.ensureCreateEnforcementEnv(uid);
        await exec(`sudo ipset add -! ${Tag.getTagDeviceMacSetName(uid)} ${this.o.mac}`).catch((err) => {
          log.error(`Failed to add tag ${uid} ${tag.o.name} on mac ${this.o.mac}`, err);
        });
        await exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {
          log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 4)} to tag ipset ${Tag.getTagSetName(uid)}`, err.message);
        });
        await exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {
          log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 6)} to tag ipset ${Tag.getTagSetName(uid)}`, err.message);
        });
        await exec(`sudo ipset add -! ${Tag.getTagDeviceSetName(uid)} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {
          log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 4)} to tag ipset ${Tag.getTagDeviceSetName(uid)}`, err.message);
        });
        await exec(`sudo ipset add -! ${Tag.getTagDeviceSetName(uid)} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {
          log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 6)} to tag ipset ${Tag.getTagDeviceSetName(uid)}`, err.message);
        });
        const dnsmasqEntry = `mac-address-group=%${this.o.mac.toUpperCase()}@${uid}`;
        await fs.writeFileAsync(`${f.getUserConfigFolder()}/dnsmasq/tag_${uid}_${this.o.mac.toUpperCase()}.conf`, dnsmasqEntry).catch((err) => {
          log.error(`Failed to write dnsmasq tag ${uid} ${tag.o.name} on mac ${this.o.mac}`, err);
        })
        updatedTags.push(uid);
      } else {
        log.warn(`Tag ${uid} not found`);
      }
    }
    this._tags = updatedTags;
    await this.setPolicyAsync("tags", this._tags); // keep tags in policy data up-to-date
    dnsmasq.scheduleRestartDNSService();
  }

  getNicUUID() {
    return this.o.intf
  }
}

module.exports = Host
