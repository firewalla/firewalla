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
const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()
const MessageBus = require('./MessageBus.js');
const messageBus = new MessageBus('info')
const sem = require('../sensor/SensorEventManager.js').getInstance();

const exec = require('child-process-promise').exec

const spoofer = require('./Spoofer.js');
const sysManager = require('./SysManager.js');

const routing = require('../extension/routing/routing.js');

const util = require('util')

const f = require('./Firewalla.js');

const { getPreferredName, getPreferredBName } = require('../util/util.js')

const bone = require("../lib/Bone.js");

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
const Ipset = require('./Ipset.js');

const {Rule} = require('./Iptables.js');

const Monitorable = require('./Monitorable');
const Constants = require('./Constants.js');

const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock(); 

const iptool = require('ip');

const envCreatedMap = {};

class Host extends Monitorable {
  constructor(obj, noEnvCreation = false) {
    if (!Monitorable.instances[obj.mac]) {
      super(obj)
      if (this.o.ipv4) {
        this.o.ipv4Addr = this.o.ipv4;
      }

      this.ipCache = new LRU({max: 50, maxAge: 150 * 1000}); // IP timeout in lru cache is 150 seconds
      this._mark = false;
      if (this.o.ipv6Addr) {
        this.ipv6Addr = this.o.ipv6Addr
      }

      // Waiting for IPTABLES_READY event is not necessary here
      // Host object should only be created after initial setup of iptables to avoid racing condition
      if (f.isMain() && !noEnvCreation) (async () => {
        this.spoofing = false;

        await this.predictHostNameUsingUserAgent();

        await Host.ensureCreateEnforcementEnv(this.o.mac)

        messageBus.subscribeOnce(this.constructor.getUpdateCh(), this.getGUID(), this.onUpdate.bind(this))

        await this.loadPolicyAsync();
        await this.applyPolicy()
        await this.identifyDevice()
      })().catch(err => {
        log.error(`Error initializing Host ${this.o.mac}`, err);
      })

      Monitorable.instances[obj.mac] = this;
      log.info('Created new Host', obj.mac)
    }
    return Monitorable.instances[obj.mac];
  }

  getUniqueId() {
    return this.o.mac
  }

  async update(obj, quick = false) {
    await lock.acquire(`UPDATE_${this.getGUID()}`, async () => {
      await super.update(obj, quick)

      if (this.o.ipv4) {
        this.o.ipv4Addr = this.o.ipv4;
      }

      if (f.isMain()) {
        await this.predictHostNameUsingUserAgent();
        if (!quick) await this.loadPolicyAsync();
      }

      for (const f of Host.metaFieldsJson) {
        this[f] = this.o[f]
      }
    }).catch((err) => {
      log.error(`Failed to update Host ${this.o.mac}`, err.message);
    });
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

  static async ensureCreateEnforcementEnv(mac) {
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

  async destroyEnv() {
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

  async setPolicyAsync(name, policy) {
    if (!this.policy) await this.loadPolicyAsync();
    if (name == 'dnsmasq') {
      if (policy.alternativeIp && policy.type === "static") {
        const mySubnet = sysManager.mySubnet();
        if (!iptool.cidrSubnet(mySubnet).contains(policy.alternativeIp)) {
          throw new Error(`Alternative IP address should be in ${mySubnet}`)
        }
      }
      if (policy.secondaryIp && policy.type === "static") {
        const mySubnet2 = sysManager.mySubnet2();
        if (!iptool.cidrSubnet(mySubnet2).contains(policy.secondaryIp)) {
          throw new Error(`Secondary IP address should be in ${mySubnet2}`)
        }
      }
    }

    await super.setPolicyAsync(name, policy)
  }

  keepalive() {
    if (this.o.ipv4Addr) // this may trigger arp request to the device, the reply from the device will be captured in ARPSensor
      linux.ping4(this.o.ipv4Addr)
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

    const detect = this.o.detect
    const toSave = []
    if (detect) {
      const nameElements = [detect.brand, detect.model].filter(Boolean)
      if (nameElements.length) {
        this.o.pname = "(?) " + nameElements.join(' ')
        toSave.push("pname")
        log.debug(">>>>>>>>>>>> ", this.o.mac, this.o.pname)
      }
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

  static metaFieldsJson = [ 'ipv6Addr', 'dtype', 'activities', 'detect', 'openports', 'screenTime' ]
  static metaFieldsNumber = [ 'firstFoundTimestamp', 'lastActiveTimestamp', 'bnameCheckTime', 'spoofingTime', '_identifyExpiration' ]

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
        log.verbose(`Profile id is not set on ${this.o.mac}`);
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
      await Host.ensureCreateEnforcementEnv(this.o.mac);

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
    // those fields should not be used anymore
    await rclient.hdelAsync("host:mac:" + this.o.mac, "intfIp");
    await rclient.hdelAsync("host:mac:" + this.o.mac, "staticAltIp");
    await rclient.hdelAsync("host:mac:" + this.o.mac, "staticSecIp");
    await rclient.hdelAsync("host:mac:" + this.o.mac, "dhcpIgnore");

    dnsmasq.onDHCPReservationChanged(this)
  }

  isMonitoring() {
    // this.spoofing should be changed immediately when spoof state is changed
    return this.spoofing;
  }

  async qos(policy) {
    let state = true;
    switch (typeof policy) {
      case "boolean":
        state = policy;
        break;
      case "object":
        state = policy.state;
    }
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
        .then(() => dnsmasq.onSpoofChanged(this));
      this.spoofing = state;
    } else {
      await rclient.hmsetAsync("host:mac:" + this.o.mac, 'spoofing', false, 'unspoofingTime', new Date() / 1000)
        .catch(err => log.error("Unable to set spoofing in redis", err))
        .then(() => dnsmasq.onSpoofChanged(this));
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

  onUpdate(channel, mac, id, host) {
    this.update(host, true)

    // Most policies are iptables based, change device related ipset should be good enough, to update
    // policies that leverage mechanism other than iptables, should register handler within its own domain
    this.scheduleUpdateHostData();
  }

  async destroy() {
    log.info('Deleting Host', this.o.mac)
    await super.destroy()

    messageBus.unsubscribe(this.constructor.getUpdateCh(), this.getGUID())

    if (f.isMain()) {
      // this effectively stops all iptables rules against this device
      // PolicyManager2 should be dealing with iptables entries alone
      await this.destroyEnv().catch((err) => { log.error('Error destorying environment', err) });

      await this.resetPolicies().catch(err => { log.error('Error reseting policy', err) });

      if (this.invalidateHostsFileTask)
        clearTimeout(this.invalidateHostsFileTask);
      const hostsFile = Host.getHostsFilePath(this.o.mac);
      await fs.unlinkAsync(hostsFile).then(() => {
        dnsmasq.scheduleReloadDNSService();
        this._lastHostfileEntries = null;
      }).catch((err) => {});

      // delete redis host keys
      if (this.o.ipv4Addr) {
        await rclient.unlinkAsync(`host:ip4:${this.o.ipv4Addr}`)
      }
      if (Array.isArray(this.ipv6Addr) && this.ipv6Addr.length) {
        await rclient.unlinkAsync(this.ipv6Addr.map(ip6 => `host:ip6:${ip6}`))
      }
      await rclient.unlinkAsync(`host:mac:${this.o.mac}`)
      await rclient.unlinkAsync(`neighbor:${this.getGUID()}`);
      await rclient.unlinkAsync(`host:user_agent2:${this.getGUID()}`);
    }

    this.ipCache.reset();
    delete envCreatedMap[this.o.mac];
    delete instances[this.o.mac]
  }

  scheduleUpdateHostData() {
    if (this.updateHostDataTask)
      clearTimeout(this.updateHostDataTask);
    this.updateHostDataTask = setTimeout(async () => {
      try {
        // update tracking ipset
        const macEntry = await hostTool.getMACEntry(this.o.mac);
        const ipv4Addr = macEntry && macEntry.ipv4Addr;
        const tags = [];
        for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
          const typeTags = await this.getTags(type) || [];
          Array.prototype.push.apply(tags, typeTags);
        }
        if (ipv4Addr) {
          const recentlyAdded = this.ipCache.get(ipv4Addr);
          if (!recentlyAdded) {
            const ops = [`-exist add -! ${Host.getIpSetName(this.o.mac, 4)} ${ipv4Addr}`];
            // flatten device IP addresses into tag's ipset
            // in practice, this ipset will be added to another tag's list:set if the device group belongs to a user group
            for (const tag of tags)
              ops.push(`-exist add -! ${Tag.getTagDeviceIPSetName(tag, 4)} ${ipv4Addr}`);
            await Ipset.batchOp(ops).catch((err) => {
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
              const ops = [`-exist add -! ${Host.getIpSetName(this.o.mac, 6)} ${addr}`];
              for (const tag of tags)
                ops.push(`-exist add -! ${Tag.getTagDeviceIPSetName(tag, 6)} ${addr}`);
              await Ipset.batchOp(ops).catch((err) => {
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
    const localDomains = sysManager.getInterfaces().flatMap((intf) => intf.localDomains || []);
    const suffixes = _.uniq((iface.searchDomains || []).concat([suffix]).concat(localDomains).map(s => getCanonicalizedDomainname(s.replace(/\s+/g, "."))));
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

  async resetPolicies() {
    // don't use setPolicy() here as event listener has been unsubscribed
    const defaultPolicy = this.constructor.defaultPolicy()
    const policy = {};
    await this.loadPolicyAsync();
    // override keys in this.policy with default value
    for (const key of Object.keys(this.policy)) {
      if (defaultPolicy.hasOwnProperty(key))
        policy[key] = defaultPolicy[key];
      else
        policy[key] = this.policy[key];
    }
    const policyManager = require('./PolicyManager.js');
    await policyManager.execute(this, this.o.ipv4Addr, policy);

    messageBus.publish("FeaturePolicy", "Extension:PortForwarding", null, {
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

    await dnsmasq.removeHostsFile(this)
  }

  // type:
  //  { 'human': 0-100
  async calculateDType() {
    const uaCount = await rclient.zcountAsync("host:user_agent2:" + this.o.mac, 0, -1);

    const human = uaCount / 100.0;
    this.o.dtype = {
      'human': human
    }
    await this.save('dtype')
    return this.o.dtype
  }

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
      if (neighbor.ip) neighbor._neighbor = flowUtil.hashIp(neighbor.ip);
      if (neighbor.name) neighbor._name = flowUtil.hashIp(neighbor.name);
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
    const activeTS = this.o.lastActiveTimestamp || this.o.firstFoundTimestamp
    if (activeTS && activeTS < Date.now()/1000 - 60 * 60 * 24 * 7) {
      log.verbose('HOST:IDENTIFY, inactive for long, skip')
      return
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
      name : this.o.name,
      monitored: this.policy['monitor'],
      vpnClient: this.policy['vpnClient'],
      detect: this.o.detect,
    };

    // Do not pass vendor info to cloud if vendor is unknown, this can force cloud to validate vendor oui info again.
    if(this.o.macVendor === 'Unknown') {
      delete obj.vendor;
    }

    try {
      obj.flowInCount = await rclient.zcountAsync("flow:conn:in:" + this.o.mac, "-inf", "+inf");
      obj.flowOutCount = await rclient.zcountAsync("flow:conn:out:" + this.o.mac, "-inf", "+inf");

      let neighbors = await util.promisify(this.packageTopNeighbors).bind(this)(60)
      if (neighbors) {
        obj.neighbors = this.hashNeighbors(neighbors);
      }
      // old data clean sensor should have cleaned most of obsolated entries
      const results = await rclient.zrangeAsync(`host:user_agent2:${this.o.mac}`, 0, -1)
      if (results.length) obj.agents = results.map(str => JSON.parse(str).ua)

      if (this.ipv6Addr) {
        obj.ipv6Addr = this.ipv6Addr.filter(currentIp => !currentIp.startsWith("fe80::"));
      }

      // assign policy values just before request to give it enough time to load policy from constructor
      obj.monitored = this.policy.monitor
      obj.vpnClient = this.policy.vpnClient

      let data = await bone.deviceAsync("identify", obj).catch(err => {
        // http error, no need to log host data
        log.error('Error identify host', obj.ipv4, obj.name || obj.bname, err)
      })
      if (data) {
        log.debug("HOST:IDENTIFY:RESULT", this.name(), data);

        if (data._identifyExpiration) {
          this.o._identifyExpiration = data._identifyExpiration
          delete data._identifyExpiration
        } else {
          this.o._identifyExpiration = Date.now()/1000 + 3600*24*3
        }

        if (data._vendor && (!this.o.macVendor || this.o.macVendor === 'Unknown')) {
          this.o.macVendor = data._vendor;
        }

        if (!this.o.detect) this.o.detect = {}
        this.o.detect.cloud = data
        await this.save('_identifyExpiration')
        sem.emitLocalEvent({
          type: 'DetectUpdate',
          from: 'cloud',
          mac: this.o.mac,
          detect: data,
          suppressEventLogging: true,
        })
      }

    } catch (e) {
      log.error("HOST:IDENTIFY:ERROR", obj, e);
    }
    return obj;
  }

  name() {
    return this.getReadableName()
  }

  getReadableName() {
    return getPreferredName(this.o) || super.getReadableName()
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
      stpPort: this.o.stpPort,
    }

    const pickAssignment = [
      'activities', 'name', 'modelName', 'manufacturer', 'openports', 'screenTime', 'pinned', 'detect'
    ]
    // undefined fields won't be serialized in HTTP response, don't bother checking
    for (const f of pickAssignment) {
      json[f] = this.o[f]
    }

    const preferredBName = getPreferredBName(this.o)

    if (preferredBName) {
      json.bname = preferredBName
    }

    json.names = this.getNameCandidates()

    if (this.hostname) {
      json._hostname = this.hostname
    }
    if (this.policy) {
      const policy = Object.assign({}, this.policy); // a copy of this.policy
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const config = Constants.TAG_TYPE_MAP[type];
        const policyKey = config.policyKey;
        const tags = policy[policyKey];
        policy[policyKey] = [];
        json[policyKey] = policy[policyKey];
        if (_.isArray(tags)) {
          const TagManager = require('./TagManager.js');
          for (const uid of tags) {
            const tag = TagManager.getTagByUid(uid);
            if (tag)
              policy[policyKey].push(uid);
          }
        }
      }
      json.policy = policy;
    }
    if (this.flowsummary) {
      json.flowsummary = this.flowsummary;
    }
    if (this.hasOwnProperty("stale"))
      json.stale = this.stale;

    json.wifiSD = this.wifiSD

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

  async tags(tags, type = Constants.TAG_TYPE_GROUP) {
    const policyKey = _.get(Constants.TAG_TYPE_MAP, [type, "policyKey"]);
    if (!policyKey) {
      log.error(`Unknown tag type ${type}, ignore tags`, tags);
      return;
    }
    tags = (tags || []).map(String);
    this[`_${policyKey}`] = this[`_${policyKey}`] || [];
    if (!this.o || !this.o.mac) {
      log.error(`Mac address is not defined`);
      return;
    }
    const macEntry = await hostTool.getMACEntry(this.o.mac);
    const ipv4Addr = macEntry && macEntry.ipv4Addr;
    const ipv6Addrs = macEntry && macEntry.ipv6Addr && JSON.parse(macEntry.ipv6Addr);
    // remove old tags that are not in updated tags
    const removedTags = this[`_${policyKey}`].filter(uid => !tags.includes(uid));
    for (let removedTag of removedTags) {
      const tagExists = await TagManager.tagUidExists(removedTag, type);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(removedTag);
        await exec(`sudo ipset del -! ${Tag.getTagDeviceMacSetName(removedTag)} ${this.o.mac}`).catch((err) => {});
        if (ipv4Addr)
          await exec(`sudo ipset del -! ${Tag.getTagDeviceIPSetName(removedTag, 4)} ${ipv4Addr}`).catch((err) => {});
        if (_.isArray(ipv6Addrs)) {
          for (const ipv6Addr of ipv6Addrs)
            await exec(`sudo ipset del -! ${Tag.getTagDeviceIPSetName(removedTag, 6)} ${ipv6Addr}`).catch((err) => {});
        }
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
      const tagExists = await TagManager.tagUidExists(uid, type);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(uid);
        await exec(`sudo ipset add -! ${Tag.getTagDeviceMacSetName(uid)} ${this.o.mac}`).catch((err) => {
          log.error(`Failed to add tag ${uid} on mac ${this.o.mac}`, err);
        });
        if (ipv4Addr)
          await exec(`sudo ipset add -! ${Tag.getTagDeviceIPSetName(uid, 4)} ${ipv4Addr}`).catch((err) => {});
        if (_.isArray(ipv6Addrs)) {
          for (const ipv6Addr of ipv6Addrs)
            await exec(`sudo ipset add -! ${Tag.getTagDeviceIPSetName(uid, 6)} ${ipv6Addr}`).catch((err) => {});
        }
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
          log.error(`Failed to write dnsmasq tag ${uid} on mac ${this.o.mac}`, err);
        })
        updatedTags.push(uid);
      } else {
        log.warn(`Tag ${uid} not found`);
      }
    }
    dnsmasq.scheduleRestartDNSService();
    dnsmasq.onDHCPReservationChanged(this)
    this[`_${policyKey}`] = updatedTags;
    await this.setPolicyAsync(policyKey, this[`_${policyKey}`]); // keep tags in policy data up-to-date
  }

  getNicUUID() {
    return this.o.intf
  }
}

module.exports = Host
