/*    Copyright 2016-2020 Firewalla INC
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

const Spoofer = require('./Spoofer.js');
const sysManager = require('./SysManager.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');

const util = require('util')

const f = require('./Firewalla.js');

const getPreferredBName = require('../util/util.js').getPreferredBName

const bone = require("../lib/Bone.js");

const MobileDetect = require('mobile-detect');

const flowUtil = require('../net2/FlowUtil.js');

const linux = require('../util/linux.js');

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()

const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');

const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');

const getCanonicalizedDomainname = require('../util/getCanonicalizedURL').getCanonicalizedDomainname;

const TagManager = require('./TagManager.js');
const Tag = require('./Tag.js');

const {Rule} = require('./Iptables.js');
const ipset = require('./Ipset.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new Dnsmasq();
const _ = require('lodash');

const instances = {}; // this instances cache can ensure that Host object for each mac will be created only once.
                      // it is necessary because each object will subscribe HostPolicy:Changed message.
                      // this can guarantee the event handler function is run on the correct and unique object.

const envCreatedMap = {};

class Host {
  constructor(obj, mgr, callback) {
    if (!instances[obj.mac]) {
      this.callbacks = {};
      this.o = obj;
      this.mgr = mgr;
      if (this.o.ipv4) {
        this.o.ipv4Addr = this.o.ipv4;
      }

      this._mark = false;
      this.parse();

      let c = require('./MessageBus.js');
      this.subscriber = new c('debug');

      if (f.isMain()) {
        this.spoofing = false;
        sclient.on("message", (channel, message) => {
          this.processNotifications(channel, message);
        });

        if (obj && obj.mac) {
          this.subscribe(this.o.mac, "Notice:Detected");
          this.subscribe(this.o.mac, "Intel:Detected");
          this.subscribe(this.o.mac, "HostPolicy:Changed");
        }

        this.predictHostNameUsingUserAgent();

        this.loadPolicy(callback);

        Host.ensureCreateDeviceIpset(this.o.mac).then(() => {
          this.subscribe(this.o.mac, "Device:Updated");
        }).catch((err) => {
          log.error(`Failed to create tracking ipset for ${this.o.mac}`, err.message);
        })
      }

      this.dnsmasq = new DNSMASQ();
      instances[obj.mac] = this;
    }
    return instances[obj.mac];
  }

  update(obj) {
    this.o = obj;
    if (this.o.ipv4) {
      this.o.ipv4Addr = this.o.ipv4;
    }

    if(f.isMain()) {
      if (obj && obj.mac) {
        this.subscribe(this.o.mac, "Notice:Detected");
        this.subscribe(this.o.mac, "Intel:Detected");
        this.subscribe(this.o.mac, "HostPolicy:Changed");
      }
      this.predictHostNameUsingUserAgent();
      this.loadPolicy(null);
    }

    this.parse();
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

      //await this.saveAsync();
      log.debug("Host:CleanV6:", this.o.mac, JSON.stringify(this.ipv6Addr));
    } catch(err) {
      log.error("Got error when cleanV6", err)
    }
  }

  predictHostNameUsingUserAgent() {
    if (this.hasBeenGivenName() == false) {
      rclient.smembers("host:user_agent_m:" + this.o.mac, (err, results) => {
        if (results != null && results.length > 0) {
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
          if (mobile == true) {
            this.o.deviceClass = "mobile";
            this.save("deviceClass", null);
          }
          if (this.o.ua_os_name) {
            this.save("ua_os_name", null);
          }
          if (this.o.ua_name) {
            this.save("ua_name", null);
          }
          if (this.o.pname) {
            this.save("pname", null);
          }
      }
      });
    }
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

  saveAsync(tuple) {
    return new Promise((resolve, reject) => {
      this.save(tuple,(err, data) => {
        if(err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }

  save(tuple, callback) {
    if (tuple == null) {
      this.redisfy();
      rclient.hmset("host:mac:" + this.o.mac, this.o, (err) => {
        if (callback) {
          callback(err);
        }
      });
    } else {
      this.redisfy();
      log.debug("Saving ", this.o.ipv4Addr, tuple, this.o[tuple]);
      let obj = {};
      obj[tuple] = this.o[tuple];
      rclient.hmset("host:mac:" + this.o.mac, obj, (err) => {
        if (callback) {
          callback(err);
        }
      });
    }
  }

  setAdmin(tuple, value) {
    if (this.admin == null) {
      this.admin = {};
    }
    this.admin[tuple] = value;
    this.redisfy();

    rclient.hmset("host:mac:" + this.o.mac, {
      'admin': this.o.admin
    });
  }

  getAdmin(tuple) {
    if (this.admin == null) {
      return null;
    }
    return this.admin[tuple];
  }

  parse() {
    if (this.o.ipv6Addr) {
      this.ipv6Addr = JSON.parse(this.o.ipv6Addr);
    }
    if (this.o.admin) {
      this.admin = JSON.parse(this.o.admin);
    }
    if (this.o.dtype) {
      this.dtype = JSON.parse(this.o.dtype);
    }
    if (this.o.activities) {
      this.activities= JSON.parse(this.o.activities);
    }
  }

  redisfy() {
    if (this.ipv6Addr) {
      this.o.ipv6Addr = JSON.stringify(this.ipv6Addr);
    }
    if (this.admin) {
      this.o.admin = JSON.stringify(this.admin);
    }
    if (this.dtype) {
      this.o.dtype = JSON.stringify(this.dtype);
    }
    if (this.activities) {
      this.o.activities= JSON.stringify(this.activities);
    }
    if (this._tags) {
      this.o.tags = JSON.stringify(this._tags);
    }
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
      if (!profileId) {
        log.warn("VPN client profileId is not specified for " + this.o.mac);
        return false;
      }
      const ovpnClient = new OpenVPNClient({profileId: profileId});
      const intf = ovpnClient.getInterfaceName();
      const rtId = await vpnClientEnforcer.getRtId(intf);
      if (!rtId)
        return false;
      const rtIdHex = Number(rtId).toString(16);
      if (state === true) {
        // set skbmark
        await exec(`sudo ipset -! del c_vpn_client_m_set ${this.o.mac}`);
        await exec(`sudo ipset -! add c_vpn_client_m_set ${this.o.mac} skbmark 0x${rtIdHex}/0xffff`);
      }
      if (state === false) {
        // clear skbmark
        await exec(`sudo ipset -! del c_vpn_client_m_set ${this.o.mac}`);
        await exec(`sudo ipset -! add c_vpn_client_m_set ${this.o.mac} skbmark 0x0000/0xffff`);
      }
      if (state === null) {
        // do not change skbmark
        await exec(`sudo ipset -! del c_vpn_client_m_set ${this.o.mac}`);
      }
      return true;
    } catch (err) {
      log.error("Failed to set VPN client access on " + this.o.mac);
      return false;
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


  async spoof(state) {
    log.debug("Spoofing ", this.o.ipv4Addr, this.ipv6Addr, this.o.mac, state, this.spoofing);
    if (this.o.ipv4Addr == null) {
      log.info("Host:Spoof:NoIP", this.o);
      return;
    }
    if (this.spoofing != state) {
      log.info(`Host:Spoof: ${this.o.name}, ${this.o.ipv4Addr}, ${this.o.mac},`
        + ` current spoof state: ${this.spoofing}, new spoof state: ${state}`)
    }
    // set spoofing data in redis and trigger dnsmasq reload hosts
    if (state === true) {
      await rclient.hmsetAsync("host:mac:" + this.o.mac, 'spoofing', true, 'spoofingTime', new Date() / 1000)
        .catch(err => log.error("Unable to set spoofing in redis", err))
        .then(() => this.dnsmasq.onSpoofChanged());
      this.spoofing = state;
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF_MAC} ${this.o.mac}`).catch((err) => {
        log.error(`Failed to remove ${this.o.mac} from ${ipset.CONSTANTS.IPSET_MONITORING_OFF_MAC}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {
        log.error(`Failed to remove ${Host.getIpSetName(this.o.mac, 4)} from ${ipset.CONSTANTS.IPSET_MONITORING_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {
        log.error(`Failed to remove ${Host.getIpSetName(this.o.mac, 6)} from ${ipset.CONSTANTS.IPSET_MONITORING_OFF}`, err.message);
      });
    } else {
      await rclient.hmsetAsync("host:mac:" + this.o.mac, 'spoofing', false, 'unspoofingTime', new Date() / 1000)
        .catch(err => log.error("Unable to set spoofing in redis", err))
        .then(() => this.dnsmasq.onSpoofChanged());
      this.spoofing = false;
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF_MAC} ${this.o.mac}`).catch((err) => {
        log.error(`Failed to add ${this.o.mac} to ${ipset.CONSTANTS.IPSET_MONITORING_OFF_MAC}`, err);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF} ${Host.getIpSetName(this.o.mac, 4)}`).catch((err) => {
        log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 4)} to ${ipset.CONSTANTS.IPSET_MONITORING_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF} ${Host.getIpSetName(this.o.mac, 6)}`).catch((err) => {
        log.error(`Failed to add ${Host.getIpSetName(this.o.mac, 6)} to ${ipset.CONSTANTS.IPSET_MONITORING_OFF}`, err.message);
      });
    }

    const iface = sysManager.getInterfaceViaIP4(this.o.ipv4Addr);
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

    const spoofer = new Spoofer({}, false);

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
    log.debug("RX Notifcaitons", channel, message);
    if (channel.toLowerCase().indexOf("notice") >= 0) {
      if (this.callbacks.notice != null) {
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
      if (type === "Notice:Detected") {
        if (this.callbacks[e]) {
          this.callbacks[e](channel, ip, type, obj);
        }
      } else if (type === "Intel:Detected") {
        // no need to handle intel here.
      } else if (type === "HostPolicy:Changed" && f.isMain()) {
        this.scheduleApplyPolicy();
        log.info("HostPolicy:Changed", channel, mac, ip, type, obj);
      } else if (type === "Device:Updated" && f.isMain()) {
        // update tracking ipset
        const macEntry = await hostTool.getMACEntry(this.o.mac);
        const ipv4Addr = macEntry && macEntry.ipv4Addr;
        if (ipv4Addr) {
          await exec(`sudo ipset -exist add -! ${Host.getIpSetName(this.o.mac, 4)} ${ipv4Addr}`).catch((err) => {
            log.error(`Failed to add ${ipv4Addr} to ${Host.getIpSetName(this.o.mac, 4)}`, err.message);
          });
        }
        let ipv6Addr = null;
        try {
          ipv6Addr = macEntry && macEntry.ipv6Addr && JSON.parse(macEntry.ipv6Addr);
        } catch (err) {}
        if (Array.isArray(ipv6Addr)) {
          for (const addr of ipv6Addr) {
            await exec(`sudo ipset -exist add -! ${Host.getIpSetName(this.o.mac, 6)} ${addr}`).catch((err) => {
              log.error(`Failed to add ${addr} to ${Host.getIpSetName(this.o.mac, 6)}`, err.message);
            });
          }
        }
        await this.updateHostsFile();
      }
    });
  }

  async updateHostsFile() {
    const macEntry = await hostTool.getMACEntry(this.o.mac);
    const ipv4Addr = macEntry && macEntry.ipv4Addr;
    // update hosts file in dnsmasq
    const hostsFile = Host.getHostsFilePath(this.o.mac);
    const suffix = await rclient.getAsync('local:domain:suffix') || "lan";
    const localDomain = macEntry.localDomain || "";
    const userLocalDomain = macEntry.userLocalDomain || "";
    const lastActiveTimestamp = Number(macEntry.lastActiveTimestamp || 0);
    if (Date.now() / 1000 - lastActiveTimestamp > 1800) {
      // remove hosts file if it is not active in the last 30 minutes
      await fs.unlinkAsync(hostsFile).catch((err) => { });
      dnsmasq.scheduleReloadDNSService();
      return;
    }
    if (!ipv4Addr) {
      await fs.unlinkAsync(hostsFile).catch((err) => { });
      dnsmasq.scheduleReloadDNSService();
      return;
    }
    let ipv6Addr = null;
    try {
      ipv6Addr = macEntry && macEntry.ipv6Addr && JSON.parse(macEntry.ipv6Addr);
    } catch (err) {}
    const aliases = [localDomain, userLocalDomain].filter((d) => d.length !== 0).map(s => getCanonicalizedDomainname(s.replace(/\s+/g, "."))).filter((v, i, a) => {
      return a.indexOf(v) === i;
    })
    const iface = sysManager.getInterfaceViaIP4(ipv4Addr);
    if (!iface) {
      await fs.unlinkAsync(hostsFile).catch((err) => { });
      dnsmasq.scheduleReloadDNSService();
      return;
    }
    const suffixes = (iface.searchDomains || []).concat([suffix]).map(s => getCanonicalizedDomainname(s.replace(/\s+/g, "."))).filter((v, i, a) => {
      return a.indexOf(v) === i;
    });
    const entries = [];
    for (const suffix of suffixes) {
      for (const alias of aliases) {
        const fqdn = `${alias}.${suffix}`;
        entries.push(`${ipv4Addr} ${fqdn}`);
        if (_.isArray(ipv6Addr)) {
          for (const addr of ipv6Addr) {
            entries.push(`${addr} ${fqdn}`);
          }
        }
      }
    }
    if (entries.length !== 0) {
      await fs.writeFileAsync(hostsFile, entries.join("\n"));
      dnsmasq.scheduleReloadDNSService();
    } else {
      await fs.unlinkAsync(hostsFile).catch((err) => { });
      dnsmasq.scheduleReloadDNSService();
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
      }).catch((err) => {});
    }, 1800 * 1000);
  }

  static getHostsFilePath(mac) {
    return `${f.getRuntimeInfoFolder()}/hosts/${mac}`;
  }

  scheduleApplyPolicy() {
    if (this.applyPolicyTask)
      clearTimeout(this.applyPolicyTask);
    this.applyPolicyTask = setTimeout(() => {
      this.applyPolicy();
    }, 3000);
  }  

  async applyPolicyAsync() {
    await this.loadPolicyAsync()
    log.debug("HostPolicy:Changed", JSON.stringify(this.policy));
    let policy = JSON.parse(JSON.stringify(this.policy));
    // check for global
    /* no need to do this now, if global monitoring is turned off, mock bitbridge will be used
    if (this.mgr.policy.monitor != null && this.mgr.policy.monitor == false) {
      policy.monitor = false;
    }
    */
    let PolicyManager = require('./PolicyManager.js');
    let policyManager = new PolicyManager('info');

    await policyManager.executeAsync(this, this.o.ipv4Addr, policy)
  }

  applyPolicy(callback) {
    return util.callbackify(this.applyPolicyAsync).bind(this)(callback || function(){})
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
    this.dtype = {
      'human': human
    };
    await this.saveAsync();
    return this.dtype
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
          let obj = JSON.parse(neighbors[i]);
          obj['ip']=i;
          neighborArray.push(obj);
          count--;
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
      log.debug("HOST:IDENTIFY too early", this.o._identifyExpiration);
      return;
    }
    log.info("HOST:IDENTIFY",this.o.mac);
    // need to have if condition, not sending too much info if the device is ...
    // this may be used initially _identifyExpiration

    await this.calculateDType();

    let obj = {
      deviceClass: 'unknown',
      human: this.dtype,
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
      let data = await bone.deviceAsync("identify", obj)
      if (data != null) {
        log.debug("HOST:IDENTIFY:RESULT", this.name(), data);

        // pretty much set everything from cloud to local
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
        await this.saveAsync();
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
    return getPreferredBName(this.o)
  }


  toShortString() {
    let name = this.name();
    if (name == null) {
      name = "unknown";
    }
    let ip = this.o.ipv4Addr;

    let now = Date.now() / 1000;
    return ip + "\t" + name + " (" + Math.ceil((now - this.o.lastActiveTimestamp) / 60) + "m)" + " " + this.o.mac;
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
      dtype: this.dtype,
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
      intf: this.o.intf ? this.o.intf : 'Unknown'
    }

    if (this.o.ipv4Addr == null) {
      json.ip = this.o.ipv4;
    }

    const preferredBName = getPreferredBName(this.o)

    if (preferredBName) {
      json.bname = preferredBName
    }

    json.names = this.getNameCandidates()

    if (this.activities) {
      json.activities= this.activities;
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
    }
    if (this.flowsummary) {
      json.flowsummary = this.flowsummary;
    }

    if (this.o.tags) {
      try {
        json.tags= !_.isEmpty(JSON.parse(this.o.tags)) ? JSON.parse(this.o.tags) : []
      } catch (err) {
        log.error("Failed to parse tags:", err)
      }
    }

    // json.macVendor = this.name();

    return json;
  }

  async summarizeSoftware(ip, from, to) {
    try {
      const result = await rclient.zrevrangebyscoreAsync(["software:ip:" + ip, to, from]);
      let softwaresdb = {};
      log.debug("SUMMARIZE SOFTWARE: ", ip, from, to, result.length);
      for (let i in result) {
        let o = JSON.parse(result[i]);
        let obj = softwaresdb[o.name];
        if (obj == null) {
          softwaresdb[o.name] = o;
          o.lastActiveTimestamp = Number(o.ts);
          o.count = 1;
        } else {
          if (obj.lastActiveTimestamp < Number(o.ts)) {
            obj.lastActiveTimestamp = Number(o.ts);
          }
          obj.count += 1;
        }
      }

      let softwares = [];
      for (let i in softwaresdb) {
        softwares.push(softwaresdb[i]);
      }
      softwares.sort(function (a, b) {
        return Number(b.count) - Number(a.count);
      })
      let softwaresrecent = softwares.slice(0);
      softwaresrecent.sort(function (a, b) {
        return Number(b.lastActiveTimestamp) - Number(a.lastActiveTimestamp);
      })
      return {
        byCount: softwares,
        byTime: softwaresrecent
      };
    } catch (err) {
      log.error("Unable to search software");
      return {
        byCount: null,
        byTime: null
      };
    }
  }

  redisCleanRange(hours) {
    let now = Date.now() / 1000;
    rclient.zremrangebyrank("flow:conn:in:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, () => {});
    rclient.zremrangebyrank("flow:conn:out:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, () => {});
    rclient.zremrangebyrank("flow:http:out:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, () => {});
    rclient.zremrangebyrank("flow:http:in:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, () => {});
  }

  setPolicy(name, data, callback) {
    callback = callback || function() {}
    return util.callbackify(this.setPolicyAsync).bind(this)(name, data, callback)
  }

  // policy:mac:xxxxx
  async setPolicyAsync(name, data) {
    if (this.policy[name] != null && this.policy[name] == data) {
      log.debug("Host:setPolicy:Nochange", this.o.ipv4Addr, name, data);
      return;
    }
    log.debug("Host:setPolicy:Changed", this.o.ipv4Addr, name, data);
    await this.saveSinglePolicy(name, data)

    const obj = {};
    obj[name] = data;
    if (this.subscriber) {
      this.subscriber.publish("DiscoveryEvent", "HostPolicy:Changed", this.o.mac, obj);
    }
    return obj
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

  async saveSinglePolicy(name, policy) {
    this.policy[name] = policy
    let key = "policy:mac:" + this.o.mac;
    await rclient.hmsetAsync(key, name, JSON.stringify(policy))
  }

  async savePolicy() {
    let key = "policy:mac:" + this.o.mac;
    let d = {};
    for (let k in this.policy) {
      d[k] = JSON.stringify(this.policy[k]);
    }
    await rclient.hmsetAsync(key, d)
  }

  loadPolicy(callback) {
    let key = "policy:mac:" + this.o.mac;

    rclient.hgetall(key, (err, data) => {
      log.debug("Host:Policy:Load:Debug", key, data);
      if (err != null) {
        log.error("Host:Policy:Load:Error", key, err);
        if (callback) {
          callback(err, null);
        }
      } else {
        if (data) {
          this.policy = {};
          for (let k in data) {
            this.policy[k] = JSON.parse(data[k]);
          }
          if (callback)
            callback(null, data);
        } else {
          this.policy = {};
          if (callback)
            callback(null, null);
        }
      }
    });
  }

  loadPolicyAsync() {
    return util.promisify(this.loadPolicy).bind(this)()
  }

  // this only gets updated when
  isInternetAllowed() {
    if (this.policy && this.policy.blockin == true) {
      return false;
    }
    return true;
  }

  getTags() {
    if (_.isEmpty(this._tags)) {
      return [];
    }

    return this._tags;
  }

  async tags(tags) {
    tags = tags || [];
    this._tags = this._tags || [];
    if (!this.o || !this.o.mac) {
      log.error(`Mac address is not defined`);
      return;
    }
    // remove old tags that are not in updated tags
    const removedTags = this._tags.filter(uid => !(tags.includes(Number(uid)) || tags.includes(String(uid))));
    for (let removedTag of removedTags) {
      const tag = TagManager.getTagByUid(removedTag);
      if (tag) {
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
    this.save("tags", null);
  }
}

module.exports = Host
