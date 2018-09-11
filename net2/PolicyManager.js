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

var instance = null;
var log = null;
var SysManager = require('./SysManager.js');
var sysManager = new SysManager('info');

const rclient = require('../util/redis_manager.js').getRedisClient()
const fc = require('../net2/config.js');

var later = require('later');
var iptable = require('./Iptables.js');
var ip6table = require('./Ip6tables.js');

var CronJob = require('cron').CronJob;
var async = require('async');

var VpnManager = require('../vpn/VpnManager.js');

const extensionManager = require('../sensor/ExtensionManager.js')

let UPNP = require('../extension/upnp/upnp');

let DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
let dnsmasq = new DNSMASQ();

let sem = require('../sensor/SensorEventManager.js').getInstance();

let mss_client = require('../extension/ss_client/multi_ss_client.js');

var firewalla = require('../net2/Firewalla.js');

let externalAccessFlag = false;

let localPort = 8833;
let externalPort = 8833;
let UPNP_INTERVAL = 3600;  // re-send upnp port request every hour

let FAMILY_DNS = ["8.8.8.8"]; // these are just backup servers
let ADBLOCK_DNS = ["8.8.8.8"]; // these are just backup servers

var ip = require('ip');

let b = require('../control/Block.js');

let features = require('../net2/features');

const cp = require('child_process')

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

/*
127.0.0.1:6379> hgetall policy:mac:28:6A:BA:1E:14:EE
1) "blockin"
2) "false"
3) "blockout"
4) "false"
5) "family"
6) "false"
7) "monitor"
8) "true"

'block'
{[
  'id':'uid',
  'state':true/false
  'app:'...',
  'cron':'...',
  'timezone':'',
]}

*/

module.exports = class {
  constructor(loglevel) {
    if (instance == null) {
      log = require("./logger.js")("PolicyManager", loglevel);
      instance = this;
    }
    return instance;
  }

  // this should flush ip6tables as well
  flush(config, callback) {
    callback = callback || function () {
    }

    if (require('./UpgradeManager.js').isUpgrading() == true) {
      callback(null);
      return;
    }

    iptable.flush6((err, data) => {
      iptable.flush((err, data) => {
        let defaultTable = config['iptables']['defaults'];
        let myip = sysManager.myIp();
        let mysubnet = sysManager.mySubnet();
        let secondarySubnet = sysManager.secondarySubnet;
        for (let i in defaultTable) {
          defaultTable[i] = defaultTable[i].replace("LOCALIP", myip);
        }
        if (secondarySubnet) {
          for (let i in defaultTable) {
            defaultTable[i] = defaultTable[i].replace("LOCALSUBNET2", secondarySubnet);
          }
        }
        log.debug("PolicyManager:flush", defaultTable, {});
        iptable.run(defaultTable);

        // Setup iptables so that it's ready for blocking
        require('../control/Block.js').setupBlockChain();

        callback(err);
      });
    });
  }

  defaults(config) {
  }

  block(mac, protocol, src, dst, sport, dport, state, callback) {
    if (state == true) {
      if (sysManager.isMyServer(dst) || sysManager.isMyServer(src)) {
        log.error("PolicyManager:block:blockself", src, dst, state);
        callback(null);
        return;
      }
    }
    if (ip.isV4Format(src) && ip.isV4Format(dst)) {
      this.block4(mac, protocol, src, dst, sport, dport, state, callback);
    } else {
      // there is a problem with these kind of block.  Ipv6 blocking is not
      // supported for incoming (dst is home and src is some where in
      // internet
      if (ip.isV4Format(dst)) {
        callback(null, null);
        return;
      }
      this.block6(mac, protocol, src, dst, sport, dport, state, callback);
    }
  }

  block4(mac, protocol, src, dst, sport, dport, state, callback) {
    let action = '-A';
    if (state == false || state == null) {
      action = "-D";
    }
    let p = {
      action: action,
      chain: "FORWARD",
      sudo: true,
    };

    if (src && src != "0.0.0.0") {
      if (sysManager.isLocalIP(src) && mac) {
        p.mac = mac;
      } else {
        p.src = src;
      }
    }
    if (dst && dst != "0.0.0.0") {
      p.dst = dst;
    }
    if (dport) {
      p.dport = dport;
    }
    if (sport) {
      p.sport = sport;
    }
    if (protocol) {
      p.protocol = protocol;
    }

    log.info("PolicyManager:Block:IPTABLE4", JSON.stringify(p), src, dst, sport, dport, state);
    if (state == true) {
      p.action = "-D";
      iptable.drop(p, null);
      let p2 = JSON.parse(JSON.stringify(p));
      p2.action = "-A";
      iptable.drop(p2, callback);
    } else {
      iptable.drop(p, callback);
    }

  }

  block6(mac, protocol, src, dst, sport, dport, state, callback) {
    let action = '-A';
    if (state == false || state == null) {
      action = "-D";
    }
    let p = {
      action: action,
      chain: "FORWARD",
      sudo: true,
    };

    if (src) {
      if (sysManager.isLocalIP(src) && mac) {
        p.mac = mac;
      } else {
        p.src = src;
      }
    }
    if (dst) {
      p.dst = dst;
    }

    if (dport) {
      p.dport = dport;
    }
    if (sport) {
      p.sport = sport;
    }
    if (protocol) {
      p.protocol = protocol;
    }

    log.info("PolicyManager:Block:IPTABLE6", JSON.stringify(p), src, dst, sport, dport, state);
    if (state == true) {
      p.action = "-D";
      ip6table.drop(p);
      let p2 = JSON.parse(JSON.stringify(p));
      p2.action = "-A";
      ip6table.drop(p2, callback);
    } else {
      p.action = "-D";
      ip6table.drop(p, callback);
    }

  }

  familyDnsAddr(callback) {
    firewalla.getBoneInfo((err, data) => {
      if (data && data.config && data.config.dns && data.config.dns.familymode) {
        callback(null, data.config.dns.familymode);
      } else {
        callback(null, FAMILY_DNS);
      }
    });
  }

  family(ip, state, callback) {
    const ver = features.getVersion('familyMode');
    switch (ver) {
      case 'v2':
        this.familyV2(ip, state, callback);
        break;
      case 'v1':
      default:
        this.familyV1(ip, state, callback);
    }
  }

  familyV1(ip, state, callback) {
    callback = callback || function () {
    }

    if (ip !== "0.0.0.0") {
      callback(null)
      return
    }

    // rm family_filter.conf from v2
    log.info('Dnsmasq: remove family_filter.conf from v2');
    require('fs').unlink(firewalla.getUserConfigFolder() + '/dns/family_filter.conf', err => {
      if (err) {
        if (err.code === 'ENOENT') {
          log.info('Dnsmasq: No family_filter.conf, skip remove');
        } else {
          log.warn('Dnsmasq: Error when remove family_filter.conf', err, {});
        }
      }
    });

    this.familyDnsAddr((err, dnsaddrs) => {
      log.info("PolicyManager:Family:IPTABLE", ip, state, dnsaddrs.join(" "));
      if (state == true) {
        dnsmasq.setDefaultNameServers("family", dnsaddrs);
        dnsmasq.updateResolvConf().then(() => callback());
      } else {
        dnsmasq.unsetDefaultNameServers("family"); // reset dns name servers to null no matter whether iptables dns change is failed or successful
        dnsmasq.updateResolvConf().then(() => callback());
      }
    });
  }

  familyV2(ip, state, callback) {
    callback = callback || function () {
    }

    if (ip !== "0.0.0.0") {
      callback(null)
      return
    }

    this.familyDnsAddr((err, dnsaddrs) => {
      log.info("PolicyManager:Family:IPTABLE", ip, state, dnsaddrs.join(" "));
      if (state === true) {
        dnsmasq.setDefaultNameServers("family", dnsaddrs);
        dnsmasq.updateResolvConf().then(callback);
        
        // auto redirect all porn traffic in v2 mode
        categoryUpdater.iptablesRedirectCategory("porn").catch((err) => {
          log.error("Failed to redirect porn traffic, err", err, {})
        })
      } else {
        dnsmasq.unsetDefaultNameServers("family"); // reset dns name servers to null no matter whether iptables dns change is failed or successful
        dnsmasq.updateResolvConf().then(callback);

        // auto redirect all porn traffic in v2 mode
        categoryUpdater.iptablesUnredirectCategory("porn").catch((err) => {
          log.error("Failed to unredirect porn traffic, err", err, {})
        })
      }
    });

    log.info("PolicyManager:Family:Dnsmasq", ip, state);
    dnsmasq.controlFilter('family', state);
  }

  adblock(ip, state, callback) {
    callback = callback || function () {
    }

    if (ip !== "0.0.0.0") {
      callback(null)
      return
    }

    log.info("PolicyManager:Adblock:Dnsmasq", ip, state);
    dnsmasq.controlFilter('adblock', state);
  }

  async upstreamDns(policy) {

    log.info("PolicyManager:UpstreamDns:Dnsmasq", policy);
    const ips = policy.ips;
    const state = policy.state;
    const featureName = "upstream_dns";
    if (state === true) {
      await (fc.enableDynamicFeature(featureName));
      dnsmasq.setDefaultNameServers("00-upstream", ips);
      await dnsmasq.updateResolvConf();
    } else {
      await (fc.disableDynamicFeature(featureName));
      dnsmasq.unsetDefaultNameServers("00-upstream"); // reset dns name servers to null no matter whether iptables dns change is failed or successful
      await dnsmasq.updateResolvConf();
    }
  }

  async getUpstreamDns() {
    log.info("PolicyManager:UpstreamDns:getUpstreamDns");
    let value = await rclient.hgetAsync('sys:features', 'upstream_dns');

    let resp = {};
    if (value === "1") { // enabled
      resp.enabled = true;
      let ips = await dnsmasq.getCurrentNameServerList();
      resp.ip = ips[0];
    } else {
      resp.enabled = false;
    }
    return resp;
  }

  hblock(host, state) {
    log.info("PolicyManager:Block:IPTABLE", host.name(), host.o.ipv4Addr, state);
    if (state) {
      b.blockMac(host.o.mac);
    } else {
      b.unblockMac(host.o.mac);
    }
    /*
   
           this.block(null,null, host.o.ipv4Addr, null, null, state, (err, data) => {
              this.block(null,host.o.ipv4Addr, null, null, null, state, (err, data) => {
               for (let i in host.ipv6Addr) {
                   this.block6(null,null, host.ipv6Addr[i], null, null, state,(err,data)=>{
                       this.block6(null,host.ipv6Addr[i],null, null, null, state,(err,data)=>{
                       });
                   });
               }
             });
           });
   */
  }

  hfamily(host, state, callback) {
    log.info("PolicyManager:Family:IPTABLE", host.name());
    this.family(host.o.ipv4Addr, state, callback);
    for (let i in host.ipv6Addr) {
      this.family(host.ipv6Addr[i], state, callback);
    }
  }

  vpn(host, config, policies) {
    if(host.constructor.name !== 'HostManager') {
      log.error("vpn doesn't support per device policy", host);
      return; // doesn't support per-device policy
    }

    let vpnManager = new VpnManager('info');
    vpnManager.configure(config, (err) => {
      if (err != null) {
        log.error("PolicyManager:VPN", "Failed to configure vpn");
        return;
      } else {
        if (policies.vpnAvaliable == null || policies.vpnAvaliable == false) {
          vpnManager.stop();
          log.error("PolicyManager:VPN", "VPN Not avaliable");
          return;
        }
        if (config.state == true) {
          vpnManager.start((err, external, port, serverNetwork, localPort) => {
            if (err != null) {
              config.state = false;
              host.setPolicy("vpn", config);
            } else {
              config.serverNetwork = serverNetwork;
              config.localPort = localPort;
              if (external) {
                config.portmapped = true;
                host.setPolicy("vpn", config, (err) => {
                  host.setPolicy("vpnPortmapped", true);
                });
              } else {
                config.portmapped = false;
                host.setPolicy("vpn", config, (err) => {
                  host.setPolicy("vpnPortmapped", false);
                });
              }
            }
          });
        } else {
          vpnManager.stop();
        }
      }
    });
  }

  scisurf(host, config) {
    if(host.constructor.name !== 'HostManager') {
      log.error("scisurf doesn't support per device policy", host);
      return; // doesn't support per-device policy
    }

    if (config.state == true) {

      if(!mss_client.readyToStart()) {
        log.error("MSS client is not ready to start yet");
        return;
      }
      
      (async () => {
        await mss_client.start()
        log.info("SciSurf feature is enabled successfully");
      })().catch((err) => {
        log.error("Failed to start scisurf feature:", err, {})
      })

    } else {
      
      (async () => {
        await mss_client.stop()
        log.info("SciSurf feature is disabled successfully");
        dnsmasq.setUpstreamDNS(null);
      })().catch((err) => {
        log.error("Failed to disable SciSurf feature: " + err);
      })
    }
  }

  shadowsocks(host, config, callback) {
    if(host.constructor.name !== 'HostManager') {
      log.error("shadowsocks doesn't support per device policy", host);
      return; // doesn't support per-device policy
    }

    let shadowsocks = require('../extension/shadowsocks/shadowsocks.js');
    let ss = new shadowsocks('info');

    // ss.refreshConfig();
    if (!ss.configExists()) {
      log.info("Generating shadowsocks config");
      ss.refreshConfig();
    }

    if (config.state == true) {
      ss.start((err) => {
        if (err == null) {
          log.info("Shadowsocks service is started successfully");
        } else {
          log.error("Failed to start shadowsocks: " + err);
        }
      })
    } else {
      ss.stop((err) => {
        if (err == null) {
          log.info("Shadowsocks service is stopped successfully");
        } else {
          log.error("Failed to stop shadowsocks: " + err);
        }
      })
    }
  }

  dnsmasq(host, config, callback) {
    if(host.constructor.name !== 'HostManager') {
      log.error("dnsmasq doesn't support per device policy", host);
      return; // doesn't support per-device policy
    }

    if (config.state == true) {
      sem.emitEvent({
        type: "StartDNS"
      })
    } else {
      sem.emitEvent({
        type: "StopDNS"
      })
    }
  }

  addAPIPortMapping(time) {
    time = time || 1;
    setTimeout(() => {
      if (!externalAccessFlag) {
        log.info("Cancel addAPIPortMapping scheduler since externalAccessFlag is now off");
        return; // exit if the flag is still off
      }

      let upnp = new UPNP();
      upnp.addPortMapping("tcp", localPort, externalPort, "Firewalla API");
      this.addAPIPortMapping(UPNP_INTERVAL * 1000); // add port every hour
    }, time)
  }

  removeAPIPortMapping(time) {
    time = time || 1;

    setTimeout(() => {
      if (externalAccessFlag) {
        log.info("Cancel removeAPIPortMapping scheduler since externalAccessFlag is now on");
        return; // exit if the flag is still on
      }

      let upnp = new UPNP();
      upnp.removePortMapping("tcp", localPort, externalPort);
      this.removeAPIPortMapping(UPNP_INTERVAL * 1000); // remove port every hour
    }, time)

  }

  externalAccess(host, config, callback) {
    if(host.constructor.name !== 'HostManager') {
      log.error("externalAccess doesn't support per device policy", host);
      return; // doesn't support per-device policy
    }

    if (config.state == true) {
      externalAccessFlag = true;
      this.addAPIPortMapping();
    } else {
      externalAccessFlag = false;
      this.removeAPIPortMapping();
    }
  }

  execute(host, ip, policy, callback) {

    if (host.oper == null) {
      host.oper = {};
    }

    if (policy == null || Object.keys(policy).length == 0) {
      log.debug("PolicyManager:Execute:NoPolicy", ip, policy);
      host.spoof(true);
      host.oper['monitor'] = true;
      if (callback)
        callback(null, null);
      return;
    }

    log.debug("PolicyManager:Execute:", ip, policy);

    for (let p in policy) {
      if (host.oper[p] != null && JSON.stringify(host.oper[p]) === JSON.stringify(policy[p])) {
        log.debug("PolicyManager:AlreadyApplied", p, host.oper[p]);
        if (p === "monitor") {
          host.spoof(policy[p]);
        }
        continue;
      }

      // If any extension support this 'applyPolicy' hook, call it
      if (extensionManager.hasExtension(p)) {
        let hook = extensionManager.getHook(p, "applyPolicy")
        if (hook) {
          try {
            hook(policy[p])
          } catch (err) {
            log.error(`Failed to call applyPolicy hook on policy ${p}, err: ${err}`)
          }
        }
      }

      if (p === "acl") {
        continue;
      } else if (p === "blockout") {
        this.block(null, null, ip, null, null, null, policy[p]);
      } else if (p === "blockin") {
        this.hblock(host, policy[p]);
        //    this.block(null,ip,null,null,policy[p]);
      } else if (p === "family") {
        this.family(ip, policy[p], null);
      } else if (p === "adblock") {
        this.adblock(ip, policy[p], null);
      } else if (p === "upstreamDns") {
        (async () => {
          try {
            await this.upstreamDns(policy[p]);
          } catch (err) {
            log.error("Error when set upstream dns", err);
          }
        })();
      } else if (p === "monitor") {
        host.spoof(policy[p]);
      } else if (p === "vpn") {
        this.vpn(host, policy[p], policy);
      } else if (p === "shadowsocks") {
        this.shadowsocks(host, policy[p]);
      } else if (p === "scisurf") {
        this.scisurf(host, policy[p]);
      } else if (p === "externalAccess") {
        this.externalAccess(host, policy[p]);
      } else if (p === "dnsmasq") {
        // do nothing here, will handle dnsmasq at the end
      } else if (p === "block") {
        if (host.policyJobs != null) {
          for (let key in host.policyJobs) {
            let job = host.policyJobs[key];
            job.stop();
          }
          host.policyJobs = {};
        } else {
          host.policyJobs = {};
        }
        let block = policy[p];
        // for now always block according to cron

        let id = block['id'];
        if (id == null) {
          log.info("PolicyManager:Cron:Remove", block);
          continue;
        }
        if (block['cron'] == null && block['timezone'] == null) {
          continue;
        }
        if (block['cron'].length < 6) {
          log.info("PolicyManager:Cron:Remove", block);
          continue;
        }
        //host.policyJobs[id]= new CronJob('00 30 11 * * 1-5', function() {

        log.info("PolicyManager:Cron:Install", block);
        host.policyJobs[id] = new CronJob(block.cron, () => {
            log.info("PolicyManager:Cron:On=====", block);
            this.block(null, null, ip, null, null, null, true);
            if (block.duration) {
              setTimeout(() => {
                log.info("PolicyManager:Cron:Done=====", block);
                this.block(null, null, ip, null, null, null, false);
              }, block.duration * 1000 * 60);
            }
          }, () => {
            /* This function is executed when the job stops */
            log.info("PolicyManager:Cron:Off=====", block);
            this.block(null, null, ip, null, null, null, false);
          },
          true, /* Start the job right now */
          block.timeZone /* Time zone of this job. */
        );
      }

      if (p !== "dnsmasq") {
        host.oper[p] = policy[p];
      }

    }

    // put dnsmasq logic at the end, as it is foundation feature
    // e.g. adblock/family feature might configure something in dnsmasq

    if (policy["dnsmasq"]) {
      if (host.oper["dnsmasq"] != null &&
        JSON.stringify(host.oper["dnsmasq"]) === JSON.stringify(policy["dnsmasq"])) {
        // do nothing
      } else {
        this.dnsmasq(host, policy["dnsmasq"]);
        host.oper["dnsmasq"] = policy["dnsmasq"];
      }
    }


    if (policy['monitor'] == null) {
      log.debug("PolicyManager:ApplyingMonitor", ip);
      host.spoof(true);
      log.debug("PolicyManager:ApplyingMonitorDone", ip);
      host.oper['monitor'] = true;
    }

    if (callback)
      callback(null, null);
  }


  // policy { dst, src, done (true/false), state (true/false) }

  executeAcl(host, ip, policy, callback) {
    if (policy == null) {
      if (callback) {
        callback(null, null);
      }
      return;
    }
    log.debug("PolicyManager:ApplyingAcl", policy);
    if (host.appliedAcl == null) {
      host.appliedAcl = {};
    }

    // FIXME: Will got rangeError: Maximum call stack size exceeded when number of acl is huge

    if (policy.length > 1000) {
      log.warn("Too many policy rules for host", host.shname);
      callback(null, null); // self protection
      return;
    }

    /* iterate policies and see if anything need to be modified */
    for (let p in policy) {
      let block = policy[p];
      if (block._src || block._dst) {
        let newblock = JSON.parse(JSON.stringify(block));
        block.state = false;
        if (block._src) {
          newblock.src = block._src;
          delete block._src;
          delete newblock._src;
        }
        if (block._dst) {
          newblock.dst = block._dst;
          delete block._dst;
          delete newblock._dst;
        }
        policy.push(newblock);
        log.info("PolicyManager:ModifiedACL", block, newblock, {});
      }
    }

    async.eachLimit(policy, 10, (block, cb) => {
      if (policy.done != null && policy.done == true) {
        cb();
      } else {
        if (block['dst'] != null && block['src'] != null) {
          let aclkey = block['dst'] + "," + block['src'];
          if (block['protocol'] != null) {
            aclkey = block['dst'] + "," + block['src'] + "," + block['protocol'] + "," + block['sport'] + "," + block['dport'];
          }
          if (host.appliedAcl[aclkey] && host.appliedAcl[aclkey].state == block.state) {
            cb();
          } else {
            this.block(block.mac, block.protocol, block.src, block.dst, block.sport, block.dport, block['state'], (err) => {
              if (err == null) {
                if (block['state'] == false) {
                  block['done'] = true;
                }
              }
              if (block.duplex && block.duplex == true) {
                this.block(block.mac, block.protocol, block.dst, block.src, block.dport, block.sport, block['state'], (err) => {
                  cb();
                });
              } else {
                cb();
              }
            });
            host.appliedAcl[aclkey] = block;
          }
        } else {
          cb();
        }
      }
    }, (err) => {
      let changed = false;
      for (var i = policy.length - 1; i >= 0; i--) {
        if (policy[i].done && policy[i].done == true) {
          policy.splice(i, 1);
          changed = true;
        }
      }
      log.debug("Return policy splied");
      callback(null, changed);
    });
  }
}
