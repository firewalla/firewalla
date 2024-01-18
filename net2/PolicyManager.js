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

const log = require("./logger.js")(__filename);
const sysManager = require('./SysManager.js');
const rclient = require('../util/redis_manager.js').getRedisClient()
const pclient = require('../util/redis_manager.js').getPublishClient()
const Message = require('./Message.js');
const fc = require('../net2/config.js');

const _ = require('lodash');
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

const localPort = 8833;
const externalPort = 8833;
const UPNP_INTERVAL = 3600;  // re-send upnp port request every hour

const sem = require('../sensor/SensorEventManager.js').getInstance();
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const CategoryUpdater = require('../control/CategoryUpdater.js')
const categoryUpdater = new CategoryUpdater()

const { Rule } = require('../net2/Iptables.js');

const { exec } = require('child-process-promise');
const Constants = require("./Constants.js");

class PolicyManager {

  // this should flush ip6tables as well
  async flush() {
    if (require('./UpgradeManager.js').isUpgrading() == true) {
      return;
    }

    await ip6table.prepare();
    await iptable.prepare();
    await ip6table.flush()
    await iptable.flush()

    // In case diag service is running, immediate adds redirection back to prevent pairing failure
    sem.emitEvent({
      type: 'DiagRedirectionRenew',
      toProcess: 'FireKick',
      message: 'Iptables flushed by FireMain'
    })

    // ======= default iptables =======
    const secondarySubnet = sysManager.mySubnet2();
    if (platform.getDHCPCapacity() && secondarySubnet) {
      const overlayMasquerade =
        new Rule('nat').chn('FW_POSTROUTING').mth(secondarySubnet, null, 'src').jmp('MASQUERADE');
      await exec(overlayMasquerade.toCmd('-A'));
    }
    const icmpv6Redirect =
      new Rule().fam(6).chn('OUTPUT').pro('icmpv6').pam('--icmpv6-type redirect').jmp('DROP');
    await exec(icmpv6Redirect.toCmd('-D'));
    await exec(icmpv6Redirect.toCmd('-I'));

    // Setup iptables so that it's ready for blocking
    await Block.setupBlockChain();

    // setup global blocking redis match rule
    await dnsmasq.createGlobalRedisMatchRule();

    // setup active protect category mapping file
    await dnsmasq.createCategoryMappingFile("default_c", [categoryUpdater.getIPSetName("default_c"), categoryUpdater.getIPSetNameForIPV6("default_c")]);

    // device ipsets are created on creation of Host(), mostly happens on the first call of HostManager.getHostsAsync()
    // PolicyManager2 will ensure device sets are created before policy enforcement. nothing needs to be done here

    // only FireMain should be listening on this
    sem.emitLocalEvent({
      type: 'IPTABLES_READY',
      message: '--==<>==--==<>==--==<>==--==<>==--',
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

  async vpnClient(target, policy) {
    if (!target)
      return;
    switch (target.constructor.name) {
      case "HostManager": {
        const result = await target.vpnClient(policy); // result optionally contains value of state and running
        const latestPolicy = target.getPolicyFast() || {}; // in case latest policy has changed before the vpnClient function returns
        const updatedPolicy = Object.assign({}, latestPolicy.vpnClient || policy, result); // this may trigger an extra system policy apply but the result should be idempotent
        await target.setPolicyAsync("vpnClient", updatedPolicy);
        break;
      }
      default: {
        await target.vpnClient(policy);

        sem.sendEventToFireMain({
          type: Message.MSG_OSI_VERIFIED,
          message: "",
          uid: target.getUniqueId(),
          targetType: target.constructor.name
        });

        break;
      }
    }

  }

  async ipAllocation(target, policy) {
    if (!target) return;
    await target.ipAllocation(policy);
  }

  async enhancedSpoof(host, state) {
    if (host.constructor.name !== 'HostManager') {
      log.error("enhancedSpoof doesn't support per device policy", host);
      return;
    }
    host.enhancedSpoof(state);
  }

  async broute(host, policy) {
    if (policy && policy.state === true) {
      await exec(`(sudo ebtables -t nat --concurrent -Lx FW_PREROUTING | grep "-p IPv4 -d ! Multicast -j redirect") || sudo ebtables -t nat --concurrent -A FW_PREROUTING -p IPv4 -d ! Multicast -j redirect`).catch((err) => {
        log.error("Failed to add redirect ebtables rule for ipv4", err.message);
      });
      await exec(`(sudo ebtables -t nat --concurrent -Lx FW_PREROUTING | grep "-p IPv6 -d ! Multicast -j redirect") || sudo ebtables -t nat --concurrent -A FW_PREROUTING -p IPv6 -d ! Multicast -j redirect`).catch((err) => {
        log.error("Failed to add redirect ebtables rule for ipv6", err.message);
      });
    } else {
      await exec(`sudo ebtables -t nat --concurrent -D FW_PREROUTING -p IPv4 -d ! Multicast -j redirect || true`).catch((err) => {
        log.error("Failed to remove redirect ebtables rule for ipv4", err.message);
      });
      await exec(`sudo ebtables -t nat --concurrent -D FW_PREROUTING -p IPv6 -d ! Multicast -j redirect || true`).catch((err) => {
        log.error("Failed to remove redirect ebtables rule for ipv6", err.message);
      });
    }
  }

  async vpn(host, config, policies) {
    if(host.constructor.name !== 'HostManager') {
      log.error("vpn doesn't support per device policy", host);
      return; // doesn't support per-device policy
    }

    let vpnManager = new VpnManager();
    let conf = await vpnManager.configure(config);
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

  async whitelist(host, config) {
  }

  async shadowsocks(host, config) {
    if(host.constructor.name !== 'HostManager') {
      log.error("shadowsocks doesn't support per device policy", host);
      return; // doesn't support per-device policy
    }

    let shadowsocks = require('../extension/shadowsocks/shadowsocks.js');
    let ss = new shadowsocks('info');

    // ss.refreshConfig();
    if (!await ss.configExists()) {
      log.info("Generating shadowsocks config");
      await ss.refreshConfig();
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

  async dnsmasq(host, config) {
    if(host.constructor.name !== 'HostManager') {
      // per-device or per-network dnsmasq policy
      await host._dnsmasq(config);
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
    }
    if (config.secondaryDhcpRange) {
      dnsmasq.setDhcpRange("secondary", config.secondaryDhcpRange.begin, config.secondaryDhcpRange.end);
      needRestart = true;
    }
    if (config.alternativeDhcpRange) {
      dnsmasq.setDhcpRange("alternative", config.alternativeDhcpRange.begin, config.alternativeDhcpRange.end);
      needRestart = true;
    }
    if (needUpdate)
      await dnsmasq.updateResolvConf();
    if (needRestart)
      await dnsmasq.start(true);
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

  async apiInterface(host, config) {
    if(host.constructor.name !== 'HostManager') {
      log.error("apiInterface doesn't support per device policy", host);
      return;
    }

    await pclient.publishAsync(Message.MSG_SYS_API_INTERFACE_CHANGED, JSON.stringify(config))
  }

  async tags(target, config, type = Constants.TAG_TYPE_GROUP) {
    if (!target)
      return;
    if (target.constructor.name === 'HostManager') {
      log.error("tags doesn't support system policy");
      return;
    }

    try {
      await target.tags(config, type);
    } catch (err) {
      log.error("Got error when applying tags for ", target, err);
    }

    const tags = (config || []).map(String);

    if (! _.isEmpty(tags)) { // ignore if no tags added to this target
      sem.sendEventToFireMain({
        type: Message.MSG_OSI_TARGET_TAGS_APPLIED,
        message: "",
        tags: config,
        uid: target.getUniqueId(),
        targetType: target.constructor.name
      });
    }

  }

  async execute(target, ip, policy) {
    if (target.oper == null) {
      target.oper = {};
    }

    if (policy == null || Object.keys(policy).length == 0) {
      log.debug("Execute:NoPolicy", target.constructor.name, ip, policy);
      await target.spoof(true);
      target.oper['monitor'] = true;
      if (ip === "0.0.0.0" && target.constructor.name === "HostManager") {
        target.qos(false);
        target.oper['qos'] = false;
      }
      await target.ipAllocation({});
      target.oper['ipAllocation'] = {};
      return;
    }
    log.debug("Execute:", target.constructor.name, ip, policy);

    if (ip === '0.0.0.0' && target.constructor.name === "HostManager" && !policy.hasOwnProperty('qos')) {
      policy['qos'] = false;
    }
    if (!policy.hasOwnProperty('ipAllocation'))
      policy['ipAllocation'] = {};

    for (let p in policy) try {
      // keep a clone of the policy object to make sure the original policy data is not changed
      // the original data will be used for comparison to know if configured policy is updated,
      // if not updated, the applyPolicy below will not be changed

      const policyDataClone = JSON.parse(JSON.stringify(policy[p]));

      if (target.oper[p] !== undefined && JSON.stringify(target.oper[p]) === JSON.stringify(policy[p])) {
        log.debug("AlreadyApplied", p, target.oper[p]);
        if (p === "monitor") {
          await target.spoof(policy[p]);
        }
        continue;
      }
      // If any extension support this 'applyPolicy' hook, call it
      if (extensionManager.hasExtension(p)) {
        let hook = extensionManager.getHook(p, "applyPolicy")
        if (hook) {
          await hook(target, ip, policyDataClone)
        }
      }
      if (p === "domains_keep_local") {
        await dnsmasq.keepDomainsLocal(p, policyDataClone)
      } else if (p === "upstreamDns") {
        await this.upstreamDns(policyDataClone);
      } else if (p === "monitor") {
        await target.spoof(policyDataClone);
      } else if (p === "qos") {
        await target.qos(policyDataClone);
      } else if (p === "qosTimer") {
        await target.qosTimer(policyDataClone);
      } else if (p === "acl") {
        await target.acl(policyDataClone);
      } else if (p === "aclTimer") {
        await target.aclTimer(policyDataClone);
      } else if (p === "vpnClient") {
        await this.vpnClient(target, policyDataClone);
      } else if (p === "vpn") {
        await this.vpn(target, policyDataClone, policy);
      } else if (p === "shadowsocks") {
        await this.shadowsocks(target, policyDataClone);
      } else if (p === "whitelist") {
        await this.whitelist(target, policyDataClone);
      } else if (p === "shield") {
        await target.shield(policyDataClone);
      } else if (p === "enhancedSpoof") {
        await this.enhancedSpoof(target, policyDataClone);
      } else if (p === "broute") {
        await this.broute(target, policyDataClone);
      } else if (p === "externalAccess") {
        this.externalAccess(target, policyDataClone);
      } else if (p === "apiInterface") {
        await this.apiInterface(target, policyDataClone);
      } else if (p === "ipAllocation") {
        await this.ipAllocation(target, policyDataClone);
      } else if (p === "dnsmasq") {
        // do nothing here, will handle dnsmasq at the end
      } else {
        for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
          const config = Constants.TAG_TYPE_MAP[type];
          if (config.policyKey === p) {
            await this.tags(target, policyDataClone, type);
          }
        }
      }

      if (p !== "dnsmasq") {
        target.oper[p] = policy[p]; // use original policy data instead of the possible-changed clone
      }

    } catch(err) {
      log.error('Error executing policy on', target.constructor.getClassName(), target.getReadableName(), p, policy[p], err)
    }

    // put dnsmasq logic at the end, as it is foundation feature

    if (policy["dnsmasq"]) {
      if (target.oper["dnsmasq"] != null &&
        JSON.stringify(target.oper["dnsmasq"]) === JSON.stringify(policy["dnsmasq"])) {
        // do nothing
      } else {
        await this.dnsmasq(target, policy["dnsmasq"]);
        target.oper["dnsmasq"] = policy["dnsmasq"];
      }
    }


    if (policy['monitor'] == null) {
      log.debug("ApplyingMonitor", ip);
      await target.spoof(true);
      log.debug("ApplyingMonitorDone", ip);
      target.oper['monitor'] = true;
    }

    // still send vpn client done message if vpnClient is not defined in policy:system
    if (target.constructor.name === "HostManager" && !policy.hasOwnProperty("vpnClient")) {
      sem.sendEventToFireMain({
        type: Message.MSG_OSI_GLOBAL_VPN_CLIENT_POLICY_DONE,
        message: ""
      });
    }
  }
}

module.exports = new PolicyManager()
