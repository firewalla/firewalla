/*    Copyright 2016 Firewalla LLC
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
const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');
const DNSManager = require('./DNSManager.js');
const dnsManager = new DNSManager('error');
const FlowManager = require('./FlowManager.js');
const flowManager = new FlowManager('debug');

const ShieldManager = require('./ShieldManager.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');

const util = require('util')

const f = require('./Firewalla.js');

const getPreferredBName = require('../util/util.js').getPreferredBName

const bone = require("../lib/Bone.js");

const fConfig = require('./config.js').getConfig();

const MobileDetect = require('mobile-detect');

const flowUtil = require('../net2/FlowUtil.js');

const linux = require('../util/linux.js');

const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()

const VPNClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');
const vpnClientEnforcer = new VPNClientEnforcer();

const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');

class Host {
  constructor(obj, mgr, callback) {
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

    if (this.mgr.type === 'server') {
      this.spoofing = false;
      sclient.on("message", (channel, message) => {
        this.processNotifications(channel, message);
      });

      if (obj != null) {
        this.subscribe(this.o.ipv4Addr, "Notice:Detected");
        this.subscribe(this.o.ipv4Addr, "Intel:Detected");
        this.subscribe(this.o.ipv4Addr, "HostPolicy:Changed");
      }
      this.spoofing = false;

      /*
      if (this.o.ipv6Addr) {
      this.o.ipv6Addr = JSON.parse(this.o.ipv6Addr);
      }
      */
      this.predictHostNameUsingUserAgent();

      this.loadPolicy(callback);
    }

    this.dnsmasq = new DNSMASQ();
  }

  update(obj) {
    this.o = obj;
    if (this.o.ipv4) {
      this.o.ipv4Addr = this.o.ipv4;
    }

    if(this.mgr.type === 'server') {
      if (obj != null) {
        this.subscribe(this.o.ipv4Addr, "Notice:Detected");
        this.subscribe(this.o.ipv4Addr, "Intel:Detected");
        this.subscribe(this.o.ipv4Addr, "HostPolicy:Changed");
      }
      this.predictHostNameUsingUserAgent();
      this.loadPolicy(null);
    }

    this.parse();
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
      log.debug("keep alive ", this.mac,this.ipv6Addr[i]);
      linux.ping6(this.ipv6Addr[i]);
    }
    setTimeout(()=>{
      this.cleanV6();
    },1000*10);
  }

  async cleanV6() {
    try {
      if (this.ipv6Addr == null) {
        return;
      }

      let ts = (new Date())/1000;
      let lastActive = 0;
      let _ipv6Hosts = {};
      this._ipv6Hosts = {};

      for (let i in this.ipv6Addr) {
        let ip6 = this.ipv6Addr[i];
        let ip6Host = rclient.hgetallAsync("host:ip6:"+ip6);
        log.debug("Host:CleanV6:looking up v6",ip6,ip6Host)
        if (ip6Host != null) {
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
          log.info("Host:"+this.mac+","+ts+","+ip6Host.lastActiveTimestamp+","+lastActive+" Remove Old Address "+ip6,JSON.stringify(ip6Host));
        } else {
          this._ipv6Hosts[ip6] = ip6Host;
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
    };
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
        log.error("VPN client profileId is not specified for " + this.o.mac);
        return false;
      }
      const ovpnClient = new OpenVPNClient({profileId: profileId});
      const intf = ovpnClient.getInterfaceName();
      if (state === true) {
        const mode = policy.mode || "dhcp";
        await vpnClientEnforcer.enableVPNAccess(this.o.mac, mode, intf);
      } else {
        await vpnClientEnforcer.disableVPNAccess(this.o.mac);
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
        const cmd = `sudo ipset del -! no_dns_caching_mac_set ${this.o.mac}`;
        await exec(cmd);
      } else {
        const cmd = `sudo ipset add -! no_dns_caching_mac_set ${this.o.mac}`;
        await exec(cmd);
      }
    } catch (err) {
      log.error("Failed to set dnsmasq policy on " + this.o.mac, err);
    }
  }

  async ipAllocation(policy) {
    const type = policy.type;
    await rclient.hdelAsync("host:mac:" + this.o.mac, "staticAltIp");
    await rclient.hdelAsync("host:mac:" + this.o.mac, "staticSecIp");
    if (type === "dynamic") {
      this.dnsmasq.onDHCPReservationChanged();
    }
    if (type === "static") {
      const alternativeIp = policy.alternativeIp;
      const secondaryIp = policy.secondaryIp;
      if (alternativeIp)
        await rclient.hsetAsync("host:mac:" + this.o.mac, "staticAltIp", alternativeIp);
      if (secondaryIp)
        await rclient.hsetAsync("host:mac:" + this.o.mac, "staticSecIp", secondaryIp);
      this.dnsmasq.onDHCPReservationChanged();
    }
  }


  spoof(state) {
    log.debug("Spoofing ", this.o.ipv4Addr, this.ipv6Addr, this.o.mac, state, this.spoofing);
    if (this.o.ipv4Addr == null) {
      log.info("Host:Spoof:NoIP", this.o);
      return;
    }
    log.info("Host:Spoof:", this.o.name, this.o.ipv4Addr, this.o.mac, state, this.spoofing);
    let gateway = sysManager.monitoringInterface().gateway;
    let gateway6 = sysManager.monitoringInterface().gateway6;
    const dns = sysManager.myDNS();

    const spoofer = new Spoofer(sysManager.config.monitoringInterface, {}, false);

    if(fConfig.newSpoof) {
      // new spoof supports spoofing on same device for mutliple times,
      // so no need to check if it is already spoofing or not
      if (this.o.ipv4Addr === gateway || this.o.mac == null || this.o.ipv4Addr === sysManager.myIp()) {
        return;
      }

      /* This is taken care of by DnsLoopAvoidanceSensor
      if (dns && dns.includes(this.o.ipv4Addr)) {
        // do not monitor dns server's traffic
        return;
      }
      */
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
          spoofer.newSpoof(this.o.ipv4Addr)
            .then(() => {
              rclient.hmsetAsync("host:mac:" + this.o.mac, 'spoofing', true, 'spoofingTime', new Date() / 1000)
                .catch(err => log.error("Unable to set spoofing in redis", err))
                .then(() => this.dnsmasq.onSpoofChanged());
              log.info("Started spoofing", this.o.ipv4Addr, this.o.mac, this.o.name);
              this.spoofing = true;
            }).catch((err) => {
              log.error("Failed to spoof", this.o.ipv4Addr, this.o.mac, this.o.name);
            })
        })
      } else {
        spoofer.newUnspoof(this.o.ipv4Addr)
          .then(() => {
            rclient.hmsetAsync("host:mac:" + this.o.mac, 'spoofing', false, 'unspoofingTime', new Date() / 1000)
              .catch(err => log.error("Unable to set spoofing in redis", err))
              .then(() => this.dnsmasq.onSpoofChanged());
            log.debug("Stopped spoofing", this.o.ipv4Addr, this.o.mac, this.o.name);
            this.spoofing = false;
          }).catch((err) => {
            log.error("Failed to unspoof", this.o.ipv4Addr, this.o.mac, this.o.name);
          })
      }

      /* put a safety on the spoof */
      log.debug("Spoof For IPv6",this.o.mac, JSON.stringify(this.ipv6Addr),JSON.stringify(this.o.ipv6Addr));
      let myIp6 = sysManager.myIp6();
      if (this.ipv6Addr && this.ipv6Addr.length>0) {
        for (let i in this.ipv6Addr) {
          if (this.ipv6Addr[i] == gateway6) {
            continue;
          }
          if (myIp6 && myIp6.indexOf(this.ipv6Addr[i])>-1) {
            continue;
          }
          if (dns && dns.indexOf(this.ipv6Addr[i]) > -1) {
            continue;
          }
          if (state == true) {
            spoofer.newSpoof6(this.ipv6Addr[i]).then(()=>{
              log.debug("Starting v6 spoofing", this.ipv6Addr[i]);
            }).catch((err)=>{
              log.error("Failed to spoof", this.ipv6Addr);
            })
            if (i>20) {
              log.error("Failed to Spoof, over ",i, " of ", this.ipv6Addr);
              break;
            }
            // prototype
            //   log.debug("Host:Spoof:True", this.o.ipv4Addr, gateway,this.ipv6Addr,gateway6);
            //   spoofer.spoof(null, null, this.o.mac, this.ipv6Addr,gateway6);
            //   this.spoofing = true;
          } else {
            spoofer.newUnspoof6(this.ipv6Addr[i]).then(()=>{
              log.debug("Starting v6 unspoofing", this.ipv6Addr[i]);
            }).catch((err)=>{
              log.error("Failed to [v6] unspoof", this.ipv6Addr);
            })
            //    log.debug("Host:Spoof:False", this.o.ipv4Addr, gateway, this.ipv6Addr,gateway6);
            //    spoofer.unspoof(null, null, this.o.mac,this.ipv6Addr, gateway6);
            //    this.spoofing = false;
          }
        }
      }
    }
  }

  async shield(policy) {
    const shieldManager = new ShieldManager(); // ShieldManager is a singleton class
    const state = policy.state;
    if (state === true) {
      // Raise shield to block incoming connections
      await shieldManager.activateShield(this.o.mac);
    } else {
      await shieldManager.deactivateShield(this.o.mac);
    }
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
  subscribe(ip, e) {
    this.subscriber.subscribeOnce("DiscoveryEvent", e, ip, (channel, type, ip2, obj) => {
      log.debug("Host:Subscriber", channel, type, ip2, obj);
      if (type === "Notice:Detected") {
        if (this.callbacks[e]) {
          this.callbacks[e](channel, ip2, type, obj);
        }
      } else if (type === "Intel:Detected") {
        // no need to handle intel here.
      } else if (type === "HostPolicy:Changed" && this.type === "server") {
        this.applyPolicy((err)=>{
        });
        log.info("HostPolicy:Changed", channel, ip, ip2, type, obj);
      }
    });
  }

  applyPolicy(callback) {
    this.loadPolicy((err, data) => {
      log.debug("HostPolicy:Changed", JSON.stringify(this.policy));
      let policy = JSON.parse(JSON.stringify(this.policy));
      // check for global
      if (this.mgr.policy.monitor != null && this.mgr.policy.monitor == false) {
        policy.monitor = false;
      }
      let PolicyManager = require('./PolicyManager.js');
      let policyManager = new PolicyManager('info');

      policyManager.execute(this, this.o.ipv4Addr, policy, (err) => {
        dnsManager.queryAcl(this.policy.acl,(err,acls)=> {
          policyManager.executeAcl(this, this.o.ipv4Addr, acls, (err, changed) => {
            if (err == null && changed == true) {
              this.savePolicy(callback);
            } else {
              if (callback) {
                callback(null,null);
              }
            }
          });
        });
      });
    });
  }

  // type:
  //  { 'human': 0-100
  //    'type': 'Phone','desktop','server','thing'
  //    'subtype: 'ipad', 'iphone', 'nest'
  //
  calculateDType(callback) {
    rclient.smembers("host:user_agent:" + this.o.ipv4Addr, (err, results) => {
      if (results != null) {
        let human = results.length / 100.0;
        this.dtype = {
          'human': human
        };
        this.save();
        if (callback) {
          callback(null, this.dtype);
        }
      } else {
        if (callback) {
          callback(err, null);
        }
      }
      this.syncToMac(null);
    });
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

  identifyDevice(force, callback) {
    if (this.mgr.type != "server") {
      if (callback)
        callback(null, null);
      return;
    }
    if (force==false  && this.o._identifyExpiration != null && this.o._identifyExpiration > Date.now() / 1000) {
      log.debug("HOST:IDENTIFY too early", this.o._identifyExpiration);
      if (callback)
        callback(null, null);
      return;
    }
    log.info("HOST:IDENTIFY",this.o.mac);
    // need to have if condition, not sending too much info if the device is ...
    // this may be used initially _identifyExpiration

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
      name : this.name()
    };

    // Do not pass vendor info to cloud if vendor is unknown, this can force cloud to validate vendor oui info again.
    if(this.o.macVendor === 'Unknown') {
      delete obj.vendor;
    }

    if (this.o.deviceClass == "mobile") {
      obj.deviceClass = "mobile";
    }
    try {
      this.packageTopNeighbors(60,(err,neighbors)=>{
        if (neighbors) {
          obj.neighbors = this.hashNeighbors(neighbors);
        }
        rclient.smembers("host:user_agent:" + this.o.ipv4Addr, (err, results) => {
          if (results != null) {
            obj.agents = results;
            bone.device("identify", obj, (err, data) => {
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
                this.save();
              }
            });
          } else {
            if (callback) {
              callback(err, obj);
            }
          }
        });
      });
    } catch (e) {
      log.error("HOST:IDENTIFY:ERROR", obj, e);
      if (callback) {
        callback(e, null);
      }
    }
    return obj;
  }

  // sync properties to mac address, macs will not change ip's will
  //
  syncToMac(callback) {
    //TODO
    /*
                if (this.o.mac) {
                    let mackey = "host:mac:"+this.o.mac.toUpperCase();
                        rclient.hgetall(key, (err,data)=> {
                            if ( err == null) {
                                if (data!=null) {
                                    data.ipv4 = host.ipv4Addr;
                                    data.lastActiveTimestamp = Date.now()/1000;
                                    if (host.macVendor) {
                                        data.macVendor = host.macVendor;
                                    }
                               } else {
                                   data = {};
                                   data.ipv4 = host.ipv4Addr;
                                   data.lastActiveTimestamp = Date.now()/1000;
                                   data.firstFoundTimestamp = data.lastActiveTimestamp;
                                   if (host.macVendor) {
                                        data.macVendor = host.macVendor;
                                   }
                               }
                               rclient.hmset(key,data, (err,result)=> {
                         });

                }
                */

  }


  listen(tell) {}

  stopListen() {}

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

  getPreferredBName() {

    // TODO: preferred name needs to be improved in the future
    if(this.o.dhcpName) {
      return this.o.dhcpName
    }

    if(this.o.bonjourName) {
      return this.o.bonjourName
    }


    return this.o.bname
  }

  getNameCandidates() {
    let names = []

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
      ssdpName: this.o.ssdpName
    }

    if (this.o.ipv4Addr == null) {
      json.ip = this.o.ipv4;
    }

    let preferredBName = this.getPreferredBName()

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

  //This is an older function replaced by redisclean
  redisCleanRange(hours) {
    let now = Date.now() / 1000;
    rclient.zremrangebyrank("flow:conn:in:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, (err) => {});
    rclient.zremrangebyrank("flow:conn:out:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, (err) => {});
    rclient.zremrangebyrank("flow:http:out:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, (err) => {});
    rclient.zremrangebyrank("flow:http:in:" + this.o.ipv4Addr, "-inf", now - hours * 60 * 60, (err) => {});
  }

  async getHostAsync(ip) {
    return await this.getHost(ip);
  }

  async getHost(ip) {
    let key = "host:ip4:" + ip;
    log.debug("Discovery:FindHostWithIP", key, ip);
    let start = "-inf";
    let end = "+inf";
    let now = Date.now() / 1000;
    this.summarygap = Number(24);
    if (this.summarygap != null) {
      start = now - this.summarygap * 60 * 60;
      end = now;
    }
    try {
      const data = await rclient.hgetallAsync(key);
      if (data != null) {
        this.o = data;

        if(this.mgr.type === 'server') {
          this.subscribe(ip, "Notice:Detected");
          this.subscribe(ip, "Intel:Detected");
        }

        const {byCount, byTime} = await this.summarizeSoftware(ip, start, end);
        //      rclient.zrevrangebyscore(["software:ip:"+ip,'+inf','-inf'], (err,result)=> {
        this.softwareByCount = byCount;
        this.softwareByRecent = byTime;
        let result = await rclient.zrevrangebyscoreAsync(["notice:" + ip, end, start]);
        this.notice = result
        result = await rclient.zrevrangebyscoreAsync(["flow:http:in:" + ip, end, start, "LIMIT", 0, 10]);
        this.http = result;
        let {connections, activities} = flowManager.summarizeConnections(data.mac, "in", end, start, "rxdata", 1, true,false);
        this.conn = connections;
        return this;
      } else {
        return null;
      }
    } catch (err) {
      log.error("Discovery:FindHostWithIP:Error", key, err);
      return null;
    }
  }

  redisclean() {
    // deprecated, do nothing
  }

  setPolicyAsync(name, data) {
    return util.promisify(this.setPolicy).bind(this)(name, data)
  }

  // policy:mac:xxxxx
  setPolicy(name, data, callback) {
    callback = callback || function() {}

    if (name == "acl") {
      if (this.policy.acl == null) {
        this.policy.acl = [data];
      } else {
        let acls = JSON.parse(this.policy.acl);
        let found = false;
        if (acls) {
          for (let i in acls) {
            let acl = acls[i];
            if (acl.src == data.src && acl.dst == data.dst) {
              if (acl.add == data.add) {
                callback(null, null);
                log.debug("Host:setPolicy:Nochange", this.o.ipv4Addr, name, data);
                return;
              } else {
                acl.add = data.add;
                found = true;
                log.debug("Host:setPolicy:Changed", this.o.ipv4Addr, name, data);
              }
            }
          }
        }
        if (found == false) {
          acls.push(data);
        }
        this.policy.acl = acls;
      }
    } else {
      if (this.policy[name] != null && this.policy[name] == data) {
        callback(null, null);
        log.debug("Host:setPolicy:Nochange", this.o.ipv4Addr, name, data);
        return;
      }
      this.policy[name] = data;
      log.debug("Host:setPolicy:Changed", this.o.ipv4Addr, name, data);
    }
    this.savePolicy((err, data) => {
      if (err == null) {
        let obj = {};
        obj[name] = data;
        if (this.subscriber) {
          this.subscriber.publish("DiscoveryEvent", "HostPolicy:Changed", this.o.ipv4Addr, obj);
        }
        if (callback) {
          callback(null, obj);
        }
      } else {
        if (callback) {
          callback(null, null);
        }

      }
    });

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

  savePolicy(callback) {
    let key = "policy:mac:" + this.o.mac;
    let d = {};
    for (let k in this.policy) {
      d[k] = JSON.stringify(this.policy[k]);
    }
    rclient.hmset(key, d, (err, data) => {
      if (err != null) {
        log.error("Host:Policy:Save:Error", key, err);
      }
      if (callback)
        callback(err, null);
    });

  }

  loadPolicyAsync() {
    return util.promisify(this.loadPolicy).bind(this)()
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

  isFlowAllowed(flow) {
    if (this.policy && this.policy.blockin == true) {
      return false;
    }
    return true;
  }
}

module.exports = Host
