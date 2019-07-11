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
const log = require("./logger.js")("PolicyManager");
const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');
const fs = require('fs');
const rclient = require('../util/redis_manager.js').getRedisClient()
const fc = require('../net2/config.js');

const iptable = require('./Iptables.js');
const ip6table = require('./Ip6tables.js');

const Block = require('../control/Block.js');

const CronJob = require('cron').CronJob;
const async = require('async');

const VpnManager = require('../vpn/VpnManager.js');

const extensionManager = require('../sensor/ExtensionManager.js')

const UPNP = require('../extension/upnp/upnp');
const upnp = new UPNP();

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const firewalla = require('../net2/Firewalla.js');

const userConfigFolder = firewalla.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dns`;

let externalAccessFlag = false;

const delay = require('../util/util.js').delay;

const localPort = 8833;
const externalPort = 8833;
const UPNP_INTERVAL = 3600;  // re-send upnp port request every hour

let FAMILY_DNS = ["8.8.8.8"]; // these are just backup servers
let ADBLOCK_DNS = ["8.8.8.8"]; // these are just backup servers

const ip = require('ip');

const b = require('../control/Block.js');

const features = require('../net2/features');

const ssClientManager = require('../extension/ss_client/ss_client_manager.js');

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

const sem = require('../sensor/SensorEventManager.js').getInstance();

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

let iptablesReady = false

module.exports = class {
  constructor(loglevel) {
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  // this should flush ip6tables as well
  async flush(config) {
    iptablesReady = false

    if (require('./UpgradeManager.js').isUpgrading() == true) {
      return;
    }

    await ip6table.flush()
    await iptable.flush()

    let defaultTable = config['iptables']['defaults'];
    let myip = sysManager.myIp();
    let secondarySubnet = sysManager.mySubnet2();
    for (let i in defaultTable) {
      defaultTable[i] = defaultTable[i].replace("LOCALIP", myip);
    }
    if (secondarySubnet) {
      for (let i in defaultTable) {
        defaultTable[i] = defaultTable[i].replace("LOCALSUBNET2", secondarySubnet);
      }
    }
    log.debug("PolicyManager:flush", defaultTable);
    iptable.run(defaultTable);

    // Setup iptables so that it's ready for blocking
    await require('../control/Block.js').setupBlockChain();

    iptablesReady = true

    sem.emitEvent({
      type: 'IPTABLES_READY'
    });
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

  family(host, ip, state, callback) {
    const ver = features.getVersion('familyMode');
    switch (ver) {
      case 'v2':
        this.familyV2(ip, state, callback);
        break;
      case 'v1':
      default:
        this.familyV1(host, ip, state, callback);
    }
  }

  async familyV1(host, ip, state, callback) {
    callback = callback || function () {
    }

    // rm family_filter.conf from v2
    log.info('Dnsmasq: remove family_filter.conf from v2');
    fs.unlink(firewalla.getUserConfigFolder() + '/dns/family_filter.conf', err => {
      if (err) {
        if (err.code === 'ENOENT') {
          log.info('Dnsmasq: No family_filter.conf, skip remove');
        } else {
          log.warn('Dnsmasq: Error when remove family_filter.conf', err);
        }
      }
    });
    let macAddress = host && host.o && host.o.mac;
    this.familyDnsAddr((err, dnsaddrs) => {
      log.debug("PolicyManager:Family:IPTABLE", macAddress, ip, state, dnsaddrs.join(" "));
      if (ip == "0.0.0.0") {
        if (state == true) {
          dnsmasq.setDefaultNameServers("family", dnsaddrs);
          dnsmasq.updateResolvConf().then(() => callback());
        } else {
          dnsmasq.unsetDefaultNameServers("family"); // reset dns name servers to null no matter whether iptables dns change is failed or successful
          dnsmasq.updateResolvConf().then(() => callback());
        }
      } else if(macAddress){
        this.applyFamilyProtectPerDevice(macAddress, state, dnsaddrs)
      }
    });
  }

  async applyFamilyProtectPerDevice(macAddress, state, dnsaddrs){
    log.debug("======================applyFamilyProtectPerDevice===========================\n")
    log.debug(macAddress, state, dnsaddrs)
    const configFile = `${dnsmasqConfigFolder}/familyProtect_${macAddress}.conf`
    const dnsmasqentry = `server=${dnsaddrs[0]}%${macAddress.toUpperCase()}\n`
    if (state == true) {
      await fs.writeFile(configFile, dnsmasqentry)
    } else {
      await fs.unlink(configFile,err => {
        if (err) {
          if (err.code === 'ENOENT') {
            log.info(`Dnsmasq: No ${configFile}, skip remove`);
          } else {
            log.warn(`Dnsmasq: Error when remove ${configFile}`, err);
          }
        }
      })
    }
    dnsmasq.start(true)
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
          log.error("Failed to redirect porn traffic, err", err);
        })
      } else {
        dnsmasq.unsetDefaultNameServers("family"); // reset dns name servers to null no matter whether iptables dns change is failed or successful
        dnsmasq.updateResolvConf().then(callback);

        // auto redirect all porn traffic in v2 mode
        categoryUpdater.iptablesUnredirectCategory("porn").catch((err) => {
          log.error("Failed to unredirect porn traffic, err", err);
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
      await fc.enableDynamicFeature(featureName);
      dnsmasq.setDefaultNameServers("00-upstream", ips);
      await dnsmasq.updateResolvConf();
    } else {
      await fc.disableDynamicFeature(featureName);
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

  async vpnClient(host, policy) {
    const updatedPolicy = JSON.parse(JSON.stringify(policy));
    const result = await host.vpnClient(policy);
    if (policy.state === true && !result) {
      updatedPolicy.state = false;
      host.setPolicy("vpnClient", updatedPolicy);
    }
  }

  async ipAllocation(host, policy) {
    if (host.constructor.name !== 'Host') {
      log.error("ipAllocation only supports per device policy", host);
      return;
    }
    await host.ipAllocation(policy);
  }

  async enhancedSpoof(host, state) {
    if (host.constructor.name !== 'HostManager') {
      log.error("enhancedSpoof doesn't support per device policy", host);
      return;
    }
    host.enhancedSpoof(state);
  }

  async vpn(host, config, policies) {
    if(host.constructor.name !== 'HostManager') {
      log.error("vpn doesn't support per device policy", host);
      return; // doesn't support per-device policy
    }

    let vpnManager = new VpnManager();
    let conf = await vpnManager.configure(config, false);
    if (conf == null) {
      log.error("PolicyManager:VPN", "Failed to configure vpn");
      return;
    } else {
      if (policies.vpnAvaliable == null || policies.vpnAvaliable == false) {
        conf = await vpnManager.stop();
        log.error("PolicyManager:VPN", "VPN Not avaliable");
        const updatedConfig = Object.assign({}, config, conf);
        host.setPolicy("vpn", updatedConfig);
        return;
      }
      if (config.state == true) {
        conf = await vpnManager.start();
        // vpnManager.start() will return latest status of VPN server, which needs to be updated and re-enforced in system policy
        const updatedConfig = Object.assign({}, config, conf);
        host.setPolicy("vpn", updatedConfig, (err) => {
          if (updatedConfig.portmapped) {
            host.setPolicy("vpnPortmapped", true);
          } else {
            host.setPolicy("vpnPortmapped", false);
          }
        });
      } else {
        conf = await vpnManager.stop();
        // vpnManager.stop() will return latest status of VPN server, which needs to be updated and re-enforced in system policy
        const updatedConfig = Object.assign({}, config, conf);
        host.setPolicy("vpn", updatedConfig, (err) => {
          if (updatedConfig.portmapped) {
            host.setPolicy("vpnPortmapped", true);
          } else {
            host.setPolicy("vpnPortmapped", false);
          }
        });
      }
    }
  }

  scisurf(host, config) {
    if(host.constructor.name !== 'HostManager') {
      log.error("scisurf doesn't support per device policy", host);
      return; // doesn't support per-device policy
    }

    if (config.state == true) {      
      (async () => {
        const client = await ssClientManager.getSSClient();
        await client.start();
        await delay(10000);
        await client.redirectTraffic();
        log.info("SciSurf feature is enabled successfully for traffic redirection");
      })().catch((err) => {
        log.error("Failed to start scisurf feature:", err);
      })

    } else {
      
      (async () => {
        const client = await ssClientManager.getSSClient();
        await client.unRedirectTraffic();
        await client.stop();
        log.info("SciSurf feature is disabled successfully for traffic redirection");
      })().catch((err) => {
        log.error("Failed to disable SciSurf feature: " + err);
      })
    }
  }

  async whitelist(host, config) {
    if (host.constructor.name == 'HostManager') {
      if (iptablesReady)
        return Block.setupGlobalWhitelist(config.state);
      else
        // wait until basic ipables are all set
        return new Promise((resolve, reject) => {
          sem.once('IPTABLES_READY', () => {
            Block.setupGlobalWhitelist(config.state)
              .then(resolve).catch(reject)
          })
        })
    }

    if (!host.o.mac) throw new Error('Invalid host MAC');

    if (config.state)
      return Block.addMacToSet([host.o.mac], 'device_whitelist_set')
    else
      return Block.delMacFromSet([host.o.mac], 'device_whitelist_set')
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
      // per-device dnsmasq policy
      host._dnsmasq(config);
      return;
    }
    let needUpdate = false;
    let needRestart = false;
    if (config.secondaryDnsServers && Array.isArray(config.secondaryDnsServers)) {
      dnsmasq.setInterfaceNameServers("secondary", config.secondaryDnsServers);
      needUpdate = true;
    }
    if (config.alternativeDnsServers && Array.isArray(config.alternativeDnsServers)) {
      dnsmasq.setInterfaceNameServers("alternative", config.alternativeDnsServers);
      needUpdate = true;
      needRestart = true;
    }
    if (config.wifiDnsServers && Array.isArray(config.wifiDnsServers)) {
      dnsmasq.setInterfaceNameServers("wifi", config.wifiDnsServers);
      needUpdate = true;
      needRestart = true;
    }
    if (config.secondaryDhcpRange) {
      dnsmasq.setDhcpRange("secondary", config.secondaryDhcpRange.begin, config.secondaryDhcpRange.end);
      needRestart = true;
    }
    if (config.alternativeDhcpRange) {
      dnsmasq.setDhcpRange("alternative", config.alternativeDhcpRange.begin, config.alternativeDhcpRange.end);
      needRestart = true;
    }
    if (config.wifiDhcpRange) {
      dnsmasq.setDhcpRange("wifi", config.wifiDhcpRange.begin, config.wifiDhcpRange.end);
      needRestart = true;
    }
    if (needUpdate)
      dnsmasq.updateResolvConf();
    if (needRestart)
      dnsmasq.start(true);
  }

  addAPIPortMapping(time) {
    time = time || 1;
    setTimeout(() => {
      if (!externalAccessFlag) {
        log.info("Cancel addAPIPortMapping scheduler since externalAccessFlag is now off");
        return; // exit if the flag is still off
      }

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
        log.info("PolicyManager:AlreadyApplied", p, host.oper[p]);
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
            hook(host, ip, policy[p])
          } catch (err) {
            log.error(`Failed to call applyPolicy hook on ip ${ip} policy ${p}, err: ${err}`)
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
        this.family(host, ip, policy[p], null);
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
      } else if (p === "vpnClient") {
        this.vpnClient(host, policy[p]);
      } else if (p === "vpn") {
        this.vpn(host, policy[p], policy);
      } else if (p === "shadowsocks") {
        this.shadowsocks(host, policy[p]);
      } else if (p === "scisurf") {
        this.scisurf(host, policy[p]);
      } else if (p === "whitelist") {
        this.whitelist(host, policy[p]);
      } else if (p === "shield") {
        host.shield(policy[p]);
      } else if (p === "enhancedSpoof") {
        this.enhancedSpoof(host, policy[p]);
      } else if (p === "externalAccess") {
        this.externalAccess(host, policy[p]);
      } else if (p === "ipAllocation") {
        this.ipAllocation(host, policy[p]);
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
        log.info("PolicyManager:ModifiedACL", block, newblock);
      }
    }

    async.eachLimit(policy, 10, async.ensureAsync((block, cb) => {
      if (policy.done != null && policy.done == true) {
        cb();
      } else {
        let {mac, protocol, src, dst, sport, dport, state} = block;
        if (dst != null && src != null) {
          let aclkey = dst + "," + src;
          if (protocol != null) {
            aclkey = dst + "," + src + "," + protocol + "," + sport + "," + dport;
          }
          if (host.appliedAcl[aclkey] && host.appliedAcl[aclkey].state == state) {
            cb();
          } else {
            this.block(mac, protocol, src, dst, sport, dport, state, (err) => {
              if (err == null) {
                if (state == false) {
                  block.done = true;
                }
              }
              if (block.duplex && block.duplex == true) {
                this.block(mac, protocol, dst, src, dport, sport, state, (err) => {
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
    }), (err) => {
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
