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
const rclient = require('../util/redis_manager.js').getRedisClient()
const fc = require('../net2/config.js');

const iptable = require('./Iptables.js');
const ip6table = require('./Ip6tables.js');

const Block = require('../control/Block.js');

const VpnManager = require('../vpn/VpnManager.js');

const extensionManager = require('../sensor/ExtensionManager.js')

const UPNP = require('../extension/upnp/upnp');
const upnp = new UPNP();

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

let externalAccessFlag = false;

const delay = require('../util/util.js').delay;

const localPort = 8833;
const externalPort = 8833;
const UPNP_INTERVAL = 3600;  // re-send upnp port request every hour

let FAMILY_DNS = ["8.8.8.8"]; // these are just backup servers
let ADBLOCK_DNS = ["8.8.8.8"]; // these are just backup servers

const features = require('../net2/features');

const ssClientManager = require('../extension/ss_client/ss_client_manager.js');

const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

const sem = require('../sensor/SensorEventManager.js').getInstance();

const util = require('util')

let iptablesReady = false

module.exports = class {
  constructor() {
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
    await Block.setupBlockChain();

    iptablesReady = true

    sem.emitEvent({
      type: 'IPTABLES_READY'
    });
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
    }

    if (policies.vpnAvaliable == null || policies.vpnAvaliable == false) {
      conf = await vpnManager.stop();
      log.error("PolicyManager:VPN", "VPN Not avaliable");
      const updatedConfig = Object.assign({}, config, conf);
      await host.setPolicyAsync("vpn", updatedConfig);
      return;
    }
    if (config.state == true) {
      conf = await vpnManager.start();
    } else {
      conf = await vpnManager.stop();
    }
    // vpnManager.start() will return latest status of VPN server, which needs to be updated and re-enforced in system policy
    const updatedConfig = Object.assign({}, config, conf);
    await host.setPolicyAsync("vpn", updatedConfig)
    await host.setPolicyAsync("vpnPortmapped", updatedConfig.portmapped);
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
        if (!client) return
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

  shadowsocks(host, config) {
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

  dnsmasq(host, config) {
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

  externalAccess(host, config) {
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
      log.info("zhijiezhijiezhijie p", p)
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
      if (p === "upstreamDns") {
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
      }

      if (p !== "dnsmasq") {
        host.oper[p] = policy[p];
      }

    }

    // put dnsmasq logic at the end, as it is foundation feature

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

  executeAsync(host, ip, policy) {
    return util.promisify(this.execute).bind(this)(host, ip, policy)
  }
}
