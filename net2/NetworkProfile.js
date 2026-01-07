/*    Copyright 2019-2026 Firewalla Inc.
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

const f = require('./Firewalla.js');
const {Rule} = require('./Iptables.js');
const Ipset = require('./Ipset.js');
const iptc = require('../control/IptablesControl.js');
const exec = require('child-process-promise').exec;
const TagManager = require('./TagManager.js');
const Tag = require('./Tag.js');
const _ = require('lodash');
const fs = require('fs');
const Promise = require('bluebird');
const HostTool = require('./HostTool.js');
const hostTool = new HostTool();
Promise.promisifyAll(fs);
const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new Dnsmasq();
const Mode = require('./Mode.js');
const sm = require('./SpooferManager.js');
const VPNClient = require('../extension/vpnclient/VPNClient.js');
const VirtWanGroup = require('./VirtWanGroup.js');
const routing = require('../extension/routing/routing.js');
const Monitorable = require('./Monitorable');
const Constants = require('./Constants.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const { Address4, Address6 } = require('ip-address');
const sysManager = require('./SysManager.js');

const envCreatedMap = {};

class NetworkProfile extends Monitorable {
  static metaFieldsJson = ['dns', 'dns6', 'ipv4s', 'ipv4Subnets', 'ipv6', 'ipv6Subnets', 'monitoring', 'ready', 'active', 'pendingTest', 'rtid', 'origDns', 'origDns6', 'rt4Subnets', 'rt6Subnets', 'pds'];

  constructor(o) {
    if (!Monitorable.instances[o.uuid]) {
      super(o)
      this.policy = {};
      if (f.isMain()) {
        // o.monitoring indicates if this is a monitoring interface, this.spoofing may be set to false even if it is a monitoring interface
        this.spoofing = (o && o.monitoring) || false;
      }
      Monitorable.instances[o.uuid] = this;
      log.info('Created new Network:', this.getUniqueId())
    }
    return Monitorable.instances[o.uuid];
  }

  isVPNInterface() {
    return this.o.intf && (this.o.intf.startsWith("wg") || this.o.intf.startsWith("awg") || this.o.intf.startsWith("tun"));
  }

  getUniqueId() {
    return this.o.uuid
  }

  static getClassName() { return 'Network' }

  getReadableName() {
    return this.o.intf || super.getReadableName()
  }

  // in case gateway has multiple IPv6 addresses
  async rediscoverGateway6(mac) {
    const gatewayEntry = await hostTool.getMACEntry(mac).catch((err) => null);
    if (gatewayEntry)
      this._discoveredGateway6 = (gatewayEntry.ipv6Addr && JSON.parse(gatewayEntry.ipv6Addr)) || [];
    else
      this._discoveredGateway6 = [];
    if (this.o.gateway6 && !this._discoveredGateway6.includes(this.o.gateway6))
      this._discoveredGateway6.push(this.o.gateway6);

    this._monitoredGateway6 = this._monitoredGateway6 || [];
    if (_.isEqual(this._monitoredGateway6.sort(), this._discoveredGateway6.sort()))
      return;
    if (!this.o.gateway6 || !_.isArray(this.o.dns) || !this.o.dns.includes(this.o.gateway))
      // do not bother if ipv6 default route is not set or gateway ipv4 is not DNS server
      return;
    if (await Mode.isSpoofModeOn()) {
      // discovered new gateway IPv6 addresses and router also acts as dns, re-apply policy
      log.info(`New gateway IPv6 addresses are discovered, re-applying policy on ${this.o.uuid} ${this.o.intf}`, this._discoveredGateway6);
      this.scheduleApplyPolicy();
    }
  }

  async applyPolicy() {
    if (this.o.monitoring !== true) {
      log.info(`Network ${this.o.uuid} ${this.o.intf} does not require monitoring, skip apply policy`);
      return;
    }
    await super.applyPolicy()
  }

  getRedisKey() {
    return "network:uuid:" + this.getGUID()
  }

  _getPolicyKey() {
    return `policy:network:${this.o.uuid}`;
  }

  static defaultPolicy() {
    return Object.assign(super.defaultPolicy(), {
      ntp_redirect: { state: false },
    })
  }

  async ipAllocation(policy) {
    await dnsmasq.writeAllocationOption(this.o.intf, policy)
  }

  isMonitoring() {
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
      const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
      Ipset.del(Ipset.CONSTANTS.IPSET_QOS_OFF, netIpsetName);
      Ipset.del(Ipset.CONSTANTS.IPSET_QOS_OFF, netIpsetName6);
    } else {
      const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
      Ipset.add(Ipset.CONSTANTS.IPSET_QOS_OFF, netIpsetName);
      Ipset.add(Ipset.CONSTANTS.IPSET_QOS_OFF, netIpsetName6);
    }
  }

  async acl(state) {
    if (state === true) {
      const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
      Ipset.del(Ipset.CONSTANTS.IPSET_ACL_OFF, netIpsetName);
      Ipset.del(Ipset.CONSTANTS.IPSET_ACL_OFF, netIpsetName6);
    } else {
      const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
      Ipset.add(Ipset.CONSTANTS.IPSET_ACL_OFF, netIpsetName);
      Ipset.add(Ipset.CONSTANTS.IPSET_ACL_OFF, netIpsetName6);
    }
  }

  async spoof(state) {
    const spoofModeOn = await Mode.isSpoofModeOn();
    this.spoofing = state;
    if (state === true) {
      if (spoofModeOn && this.o.type === "wan") { // only spoof on wan interface
        if (this.o.gateway  && this.o.gateway.length > 0
          && this.o.ipv4 && this.o.ipv4.length > 0
          && this.o.gateway !== this.o.ipv4) {
          await sm.registerSpoofInstance(this.o.intf, this.o.gateway, this.o.ipv4, false);
        }
        if (this.o.gateway6 && this.o.gateway6.length > 0
          && this.o.ipv6 && this.o.ipv6.length > 0
          && !this.o.ipv6.includes(this.o.gateway6)) {
            let updatedGateway6 = [];
            if (!_.isArray(this.o.dns) || !this.o.dns.includes(this.o.gateway)) {
              updatedGateway6 = [this.o.gateway6];
            } else {
              updatedGateway6 = this._discoveredGateway6 || [this.o.gateway6];
              log.info(`Router also acts as DNS server, spoof all its IPv6 addresses`, updatedGateway6);
            }
            this._monitoredGateway6 = this._monitoredGateway6 || [];
            const removedGateway6 = this._monitoredGateway6.filter(i => !updatedGateway6.includes(i));
            for (let gip of removedGateway6) {
              log.info(`Disable IPv6 spoof instance on ${gip}, ${this.o.uuid} ${this.o.intf}`);
              await sm.deregisterSpoofInstance(this.o.intf, gip, true);
            }
            for (let gip of updatedGateway6) {
              log.info(`Enable IPv6 spoof instance on ${gip}, ${this.o.uuid} ${this.o.intf}`);
              await sm.registerSpoofInstance(this.o.intf, gip, this.o.ipv6[0], true);
            }
            this._monitoredGateway6 = updatedGateway6;
        }
      }
    } else {
      if (spoofModeOn && this.o.type === "wan") { // only spoof on wan interface
        if (this.o.gateway) {
          await sm.deregisterSpoofInstance(this.o.intf, "*", false);
        }
        if (this.o.gateway6 && this.o.gateway6.length > 0) {
          await sm.deregisterSpoofInstance(this.o.intf, "*", true);
          this._monitoredGateway6 = [];
        }
      }
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

  async vpnClient(policy) {
    try {
      const state = policy.state;
      const profileId = policy.profileId;
      const networkConfPath = NetworkProfile.getVPNClientDnsmasqConfigPath(this.o.uuid);
      if (this._profileId && profileId !== this._profileId) {
        log.info(`Current VPN profile id is different from the previous profile id ${this._profileId}, remove old rule on network ${this.o.uuid}`);
        const rule = new Rule("mangle").chn("FW_RT_NETWORK_5")
          .jmp(`SET --map-set ${this._profileId.startsWith("VWG:") ? VirtWanGroup.getRouteIpsetName(this._profileId.substring(4)) : VPNClient.getRouteIpsetName(this._profileId)} dst,dst --map-mark`)
          .comment(`policy:network:${this.o.uuid}`);
        const rule4 = rule.clone().set(NetworkProfile.getNetIpsetName(this.o.uuid, 4), 'src,src')
        const rule6 = rule.clone().set(NetworkProfile.getNetIpsetName(this.o.uuid, 6), 'src,src').fam(6);
        iptc.addRule(rule4.opr('-D'));
        iptc.addRule(rule6.opr('-D'));

        // remove rule that was set by state == null
        rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        iptc.addRule(rule4.opr('-D'));
        iptc.addRule(rule6.opr('-D'));
        
        const vcConfPath = `${this._profileId.startsWith("VWG:") ? VirtWanGroup.getDNSRouteConfDir(this._profileId.substring(4)) : VPNClient.getDNSRouteConfDir(this._profileId)}/vc_${this.o.uuid}.conf`;
        await fs.unlinkAsync(networkConfPath).catch((err) => {});
        await fs.unlinkAsync(vcConfPath).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }

      this._profileId = profileId;
      if (!profileId) {
        log.verbose(`Profile id is not set on ${this.o.uuid}`);
        return;
      }
      const rule = new Rule("mangle").chn("FW_RT_NETWORK_5")
          .jmp(`SET --map-set ${this._profileId.startsWith("VWG:") ? VirtWanGroup.getRouteIpsetName(profileId.substring(4)) : VPNClient.getRouteIpsetName(profileId)} dst,dst --map-mark`)
          .comment(`policy:network:${this.o.uuid}`);

      if (profileId.startsWith("VWG:"))
        await VirtWanGroup.ensureCreateEnforcementEnv(profileId.substring(4));
      else
        await VPNClient.ensureCreateEnforcementEnv(profileId);
      await NetworkProfile.ensureCreateEnforcementEnv(this.o.uuid); // just in case

      const vcConfPath = `${profileId.startsWith("VWG:") ? VirtWanGroup.getDNSRouteConfDir(profileId.substring(4)) : VPNClient.getDNSRouteConfDir(profileId)}/vc_${this.o.uuid}.conf`;

      const rule4 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 4)} src,src`);
      const rule6 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 6)} src,src`).fam(6);
      const rule4Clear = rule4.clone().jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
      const rule6Clear = rule6.clone().jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);

      if (state === true) {
        iptc.addRule(rule4);
        iptc.addRule(rule6);

        // remove rule that was set by state == null
        iptc.addRule(rule4Clear.opr('-D'));
        iptc.addRule(rule6Clear.opr('-D'));
        const markTag = `${profileId.startsWith("VWG:") ? VirtWanGroup.getDnsMarkTag(profileId.substring(4)) : VPNClient.getDnsMarkTag(profileId)}`;
        // use two config files, one in network directory, the other in vpn client hard route directory, the second file is controlled by conf-dir in VPNClient.js and will not be included when client is disconnected
        await dnsmasq.writeConfig(networkConfPath, `mac-address-tag=%00:00:00:00:00:00$vc_${this.o.uuid}`).catch((err) => {});
        await dnsmasq.writeConfig(vcConfPath, `tag-tag=$vc_${this.o.uuid}$${markTag}$!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // null means off
      if (state === null) {
        // remove rule that was set by state == true
        iptc.addRule(rule4.opr('-D'));
        iptc.addRule(rule6.opr('-D'));
        // override target and clear vpn client bits in fwmark
        iptc.addRule(rule4Clear);
        iptc.addRule(rule6Clear);
        await dnsmasq.writeConfig(networkConfPath, `mac-address-tag=%00:00:00:00:00:00$vc_${this.o.uuid}`).catch((err) => {});
        await dnsmasq.writeConfig(vcConfPath, `tag-tag=$vc_${this.o.uuid}$${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // false means N/A
      if (state === false) {
        iptc.addRule(rule4.opr('-D'));
        iptc.addRule(rule6.opr('-D'));

        // remove rule that was set by state == null
        iptc.addRule(rule4Clear.opr('-D'));
        iptc.addRule(rule6Clear.opr('-D'));
        await fs.unlinkAsync(networkConfPath).catch((err) => {});
        await fs.unlinkAsync(vcConfPath).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
    } catch (err) {
      log.error(`Failed to set VPN client access on network ${this.o.uuid} ${this.o.intf}`);
    }
  }

  async shield(policy) {
  }

  // underscore prefix? follow same function name in Host.js :(
  async _dnsmasq(policy) {
    const dnsCaching = policy.dnsCaching;
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get net ipset name for ${this.o.uuid} ${this.o.intf}`);
      return;
    }
    if (dnsCaching === true) {
      Ipset.del(Ipset.CONSTANTS.IPSET_NO_DNS_BOOST, netIpsetName);
      Ipset.del(Ipset.CONSTANTS.IPSET_NO_DNS_BOOST, netIpsetName6);
    } else {
      Ipset.add(Ipset.CONSTANTS.IPSET_NO_DNS_BOOST, netIpsetName);
      Ipset.add(Ipset.CONSTANTS.IPSET_NO_DNS_BOOST, netIpsetName6);
    }
  }

  static async destroyBakChains() {
    // Remove jump rules from INPUT chain
    iptc.addRule(new Rule().chn("INPUT").jmp("FW_INPUT_ACCEPT_BAK").opr('-D'));
    iptc.addRule(new Rule().fam(6).chn("INPUT").jmp("FW_INPUT_ACCEPT_BAK").opr('-D'));
    iptc.addRule(new Rule().chn("INPUT").jmp("FW_INPUT_DROP_BAK").opr('-D'));
    iptc.addRule(new Rule().fam(6).chn("INPUT").jmp("FW_INPUT_DROP_BAK").opr('-D'));
    // Flush chains
    iptc.addRule(new Rule().chn("FW_INPUT_ACCEPT_BAK").opr('-F'));
    iptc.addRule(new Rule().fam(6).chn("FW_INPUT_ACCEPT_BAK").opr('-F'));
    iptc.addRule(new Rule().chn("FW_INPUT_DROP_BAK").opr('-F'));
    iptc.addRule(new Rule().fam(6).chn("FW_INPUT_DROP_BAK").opr('-F'));
    // Delete chains
    iptc.addRule(new Rule().chn("FW_INPUT_ACCEPT_BAK").opr('-X'));
    iptc.addRule(new Rule().fam(6).chn("FW_INPUT_ACCEPT_BAK").opr('-X'));
    iptc.addRule(new Rule().chn("FW_INPUT_DROP_BAK").opr('-X'));
    iptc.addRule(new Rule().fam(6).chn("FW_INPUT_DROP_BAK").opr('-X'));
  }

  static getSelfIpsetName(uuid, af = 4) {
    if (uuid) {
      return `c_ip_${uuid.substring(0, 13)}_set` + (af === 4 ? "" : "6");
    } else
      return null;
  }

  static getNetIpsetName(uuid, af = 4) {
    // TODO: need find a better way to get a unique name from uuid
    if (uuid) {
      return `c_net_${uuid.substring(0, 13)}_set` + (af === 4 ? "" : "6");
    } else
      return null;
  }

  static getGatewayIpsetName(uuid, af = 4) {
    if (uuid) {
      return `c_gw_${uuid.substring(0, 13)}_set` + (af === 4 ? "" : "6");
    } else
      return null;
  }

  static getRouteIpsetName(uuid, hard = true) {
    if (uuid) {
      return `c_rt_${hard ? "hard" : "soft"}_${uuid.substring(0, 13)}_set`;
    } else
      return null;
  }

  static getOifIpsetName(uuid) {
    if (uuid) {
      return `c_oif_${uuid.substring(0, 13)}_set`;
    } else
      return null;
  }

  static getDnsmasqConfigDirectory(uuid) {
    if (uuid) {
      return `${f.getUserConfigFolder()}/dnsmasq/${uuid}/`;
    } else
      return null;
  }

  static getVPNClientDnsmasqConfigPath(uuid) {
    if (uuid) {
      return `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/vc_${uuid}.conf`;
    } else
      return null;
  }

  // This function can be called while enforcing rules on network.
  // In case the network doesn't exist at the time when policy is enforced, but may be restored from config history in future.
  // Thereby, the rule can still be applied and take effect once the network is restored
  static async ensureCreateEnforcementEnv(uuid) {

    const ensureCreateIpset = async (netIpsetName, family = 4) => {
      const createCmd = (family === 4)
        ? `sudo ipset create -! ${netIpsetName} hash:net maxelem 1024`
        : `sudo ipset create -! ${netIpsetName} hash:net family inet6 maxelem 1024`;
      const deleteCmd = `sudo ipset destroy ${netIpsetName}`;
      try {
        await exec(createCmd);
        log.info(`Successfully created ipset ${netIpsetName}`);
      } catch (createError) {
        log.warn(`Ipset ${netIpsetName} creation failed (will retry after destruction):`, createError.message);
        try {
          await exec(deleteCmd);
          await exec(createCmd);
        } catch (recreateError) {
          log.error(`Failed to successfully create/recreate ipset ${netIpsetName}.`, recreateError.message);
        }
      }
    };

    await lock.acquire(`NET_ENFORCE_${uuid}`, async() => {
      if (envCreatedMap[uuid])
        return;
      const netIpsetName = NetworkProfile.getNetIpsetName(uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(uuid, 6);
      if (!netIpsetName || !netIpsetName6) {
        log.error(`Failed to get ipset name for ${uuid}`);
      } else {
        await ensureCreateIpset(netIpsetName, 4);
        await ensureCreateIpset(netIpsetName6, 6);
      }

      const GatewayIpsetName = NetworkProfile.getGatewayIpsetName(uuid);
      const GatewayIpsetName6 = NetworkProfile.getGatewayIpsetName(uuid, 6);
      if (!GatewayIpsetName || !GatewayIpsetName6) {
        log.error(`Failed to get gateway ipset name for ${uuid}`);
      } else {
        Ipset.create(GatewayIpsetName, 'hash:ip', false, { maxelem: 32 });
        Ipset.add(Ipset.CONSTANTS.IPSET_NETWORK_GATEWAY_SET, GatewayIpsetName);
        Ipset.create(GatewayIpsetName6, 'hash:ip', true, { maxelem: 32 });
        Ipset.add(Ipset.CONSTANTS.IPSET_NETWORK_GATEWAY_SET, GatewayIpsetName6);
      }
      const selfIpsetName = NetworkProfile.getSelfIpsetName(uuid);
      const selfIpsetName6 = NetworkProfile.getSelfIpsetName(uuid, 6);
      if (!selfIpsetName || !selfIpsetName6) {
        log.error(`Failed to get self ipset name for ${uuid}`);
      } else {
        Ipset.create(selfIpsetName, 'hash:ip', false, { maxelem: 32 });
        Ipset.create(selfIpsetName6, 'hash:ip', true, { maxelem: 32 });
      }
      // routing ipset with skbmark extensions
      const hardRouteIpsetName = NetworkProfile.getRouteIpsetName(uuid);
      const hardRouteIpsetName4 = `${hardRouteIpsetName}4`;
      const hardRouteIpsetName6 = `${hardRouteIpsetName}6`;
      Ipset.create(hardRouteIpsetName, 'list:set', false, { skbinfo: true });
      Ipset.create(hardRouteIpsetName4, 'hash:net', false, { maxelem: 1024 });
      Ipset.create(hardRouteIpsetName6, 'hash:net', true, { maxelem: 1024 });

      const softRouteIpsetName = NetworkProfile.getRouteIpsetName(uuid, false);
      const softRouteIpsetName4 = `${softRouteIpsetName}4`;
      const softRouteIpsetName6 = `${softRouteIpsetName}6`;
      Ipset.create(softRouteIpsetName, 'list:set', false, { skbinfo: true });
      Ipset.create(softRouteIpsetName4, 'hash:net', false, { maxelem: 1024 });
      Ipset.create(softRouteIpsetName6, 'hash:net', true, { maxelem: 1024 });

      const oifIpsetName = NetworkProfile.getOifIpsetName(uuid);
      const oifIpsetName4 = `${oifIpsetName}4`;
      const oifIpsetName6 = `${oifIpsetName}6`;
      Ipset.create(oifIpsetName, 'list:set');
      Ipset.create(oifIpsetName4, 'hash:net,iface', false, { maxelem: 10 });
      Ipset.create(oifIpsetName6, 'hash:net,iface', true, { maxelem: 10 });

      // ensure existence of dnsmasq per-network config directory
      if (uuid) {
        await exec(`mkdir -p ${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/`).catch((err) => {
          log.error(`Failed to create dnsmasq config directory for ${uuid}`);
        });
      }
      await fs.mkdirAsync(NetworkProfile.getDNSRouteConfDir(uuid, "hard")).catch((err) => { });
      await fs.mkdirAsync(NetworkProfile.getDNSRouteConfDir(uuid, "soft")).catch((err) => { });
      envCreatedMap[uuid] = 1;
    }).catch((err) => {
      log.error(`Failed to create enforcement env for network ${uuid}`, err.message);
    });
  }

  async createEnv() {
    // create and populate related ipsets
    await NetworkProfile.ensureCreateEnforcementEnv(this.o.uuid);
    let realIntf = this.o.intf;
    if (realIntf && realIntf.endsWith(":0"))
      realIntf = realIntf.substring(0, realIntf.length - 2);
    const inputRule = new Rule().chn("FW_INPUT_DROP").iif(realIntf).mdl("conntrack", "--ctstate INVALID").mdl("conntrack", "! --ctstate DNAT").jmp("DROP").comment(this.o.uuid);
    const inputRuleSec = new Rule().chn("FW_INPUT_DROP").iif(realIntf).mdl("conntrack", "--ctstate NEW").mdl("conntrack", "! --ctstate DNAT").jmp("FW_WAN_IN_DROP").comment(this.o.uuid);
    const inputRule6 = inputRule.clone().fam(6);
    const inputRule6Sec = inputRuleSec.clone().fam(6);
    const invalidDropRule = new Rule().chn("FW_WAN_INVALID_DROP").oif(realIntf).jmp("DROP").comment(this.o.uuid);
    const invalidDropRule6 = invalidDropRule.clone().fam(6);

    const commands = [inputRule, inputRuleSec, inputRule6, inputRule6Sec, invalidDropRule, invalidDropRule6];

    if (this.o.type === "wan" && await Mode.isRouterModeOn()) {
      // add DROP rule on WAN interface in router mode
      commands.forEach(command => iptc.addRule(command.opr('-A')));
    } else {
      commands.forEach(command => iptc.addRule(command.opr('-D')));
    }

    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    let hasDefaultRTSubnets = false;
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      Ipset.flush(netIpsetName);
      if (this.o && this.o.monitoring === true) {
        if (_.isArray(this.o.ipv4Subnets)) {
          for (const subnet of this.o.ipv4Subnets)
            Ipset.add(netIpsetName, subnet);
        }
        if (_.isArray(this.o.rt4Subnets)) {
          for (const subnet of this.o.rt4Subnets) {
            if (!sysManager.isDefaultRoute(subnet))
              Ipset.add(netIpsetName, subnet);
            else
              hasDefaultRTSubnets = true;
          }
        }
      }
      
      Ipset.flush(netIpsetName6);
      if (this.o && this.o.monitoring === true) {
        if (_.isArray(this.o.ipv6Subnets)) {
          for (const subnet6 of this.o.ipv6Subnets)
            Ipset.add(netIpsetName6, subnet6);
        }
        if (_.isArray(this.o.rt6Subnets)) {
          for (const subnet6 of this.o.rt6Subnets) {
            if (!sysManager.isDefaultRoute(subnet6))
              Ipset.add(netIpsetName6, subnet6);
            else
              hasDefaultRTSubnets = true;
          }
        }
      }

      // add to c_lan_set accordingly, some feature has mandatory to be enabled on lan only, e.g., vpn client
      if (this.o.type === "lan" && this.o.monitoring === true) {
        Ipset.add('c_lan_set', netIpsetName);
        Ipset.add('c_lan_set', netIpsetName6);
      } else {
        Ipset.del('c_lan_set', netIpsetName);
        Ipset.del('c_lan_set', netIpsetName6);
      }
      // add to NAT hairpin chain if it is LAN network
      if (this.o.ipv4Subnets && this.o.ipv4Subnets.length != 0) {
        for (const subnet of this.o.ipv4Subnets) {
          const rule = new Rule("nat").chn("FW_POSTROUTING_HAIRPIN").src(subnet).jmp("MASQUERADE");
          if (this.o.type === "lan" && this.o.monitoring === true) {
            iptc.addRule(rule.opr('-A'));
          } else {
            iptc.addRule(rule.opr('-D'));
          }
        }
      }
      // add to monitored net ipset accordingly
      if (this.o.monitoring === true) {
        Ipset.add(Ipset.CONSTANTS.IPSET_MONITORED_NET, netIpsetName);
        Ipset.add(Ipset.CONSTANTS.IPSET_MONITORED_NET, netIpsetName6);
      } else {
        Ipset.del(Ipset.CONSTANTS.IPSET_MONITORED_NET, netIpsetName);
        Ipset.del(Ipset.CONSTANTS.IPSET_MONITORED_NET, netIpsetName6);
      }
    }

    if (this.o.monitoring === true) {
      const GatewayIpsetName = NetworkProfile.getGatewayIpsetName(this.o.uuid);
      const GatewayIpsetName6 = NetworkProfile.getGatewayIpsetName(this.o.uuid, 6);
      if (!GatewayIpsetName || !GatewayIpsetName6) {
        log.error(`Failed to get gateway ipset name for ${this.o.uuid}`);
      } else {
        Ipset.flush(GatewayIpsetName);
        if (this.o && this.o.gateway && typeof this.o.gateway === 'string') {
          Ipset.add(GatewayIpsetName, this.o.gateway);
        }
        Ipset.flush(GatewayIpsetName6);
        if (this.o && this.o.gateway6 && typeof this.o.gateway6 === 'string') {
          Ipset.add(GatewayIpsetName6, this.o.gateway6);
        }
        //Add DNS6 to the gateway set since IPv6 gateways typically use Link-Local addresses.
        if(this.o && _.isArray(this.o.dns6)) {
          for (const dns6 of this.o.dns6) {
            Ipset.add(GatewayIpsetName6, dns6);
          }
        }
      }
    }

    const selfIpsetName = NetworkProfile.getSelfIpsetName(this.o.uuid);
    const selfIpsetName6 = NetworkProfile.getSelfIpsetName(this.o.uuid, 6);
    if (!selfIpsetName || !selfIpsetName6) {
      log.error(`Failed to get self ipset name for ${this.o.uuid}`);
    } else {
      Ipset.flush(selfIpsetName);
      if (this.o && _.isArray(this.o.ipv4s)) {
        for (const ip4 of this.o.ipv4s)
          Ipset.add(selfIpsetName, ip4);
      }
      Ipset.flush(selfIpsetName6);
      if (this.o && _.isArray(this.o.ipv6)) {
        for (const ip6 of this.o.ipv6)
          Ipset.add(selfIpsetName6, ip6);
      }
    }

    const oifIpsetName = NetworkProfile.getOifIpsetName(this.o.uuid);
    const oifIpsetName4 = `${oifIpsetName}4`;
    const oifIpsetName6 = `${oifIpsetName}6`;
    Ipset.flush(oifIpsetName);
    Ipset.flush(oifIpsetName4);
    Ipset.flush(oifIpsetName6);

    const hardRouteIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid);
    const hardRouteIpsetName4 = `${hardRouteIpsetName}4`;
    const hardRouteIpsetName6 = `${hardRouteIpsetName}6`;
    const softRouteIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid, false);
    const softRouteIpsetName4 = `${softRouteIpsetName}4`;
    const softRouteIpsetName6 = `${softRouteIpsetName}6`;
    Ipset.flush(hardRouteIpsetName);
    Ipset.flush(hardRouteIpsetName4);
    Ipset.flush(hardRouteIpsetName6);
    Ipset.flush(softRouteIpsetName);
    Ipset.flush(softRouteIpsetName4);
    Ipset.flush(softRouteIpsetName6);
    await this._disableDNSRoute("soft");
    await this._disableDNSRoute("hard");

    if (this.o.type === "wan" || !_.isEmpty(this.o.rt4Subnets) || !_.isEmpty(this.o.rt6Subnets)) {
      Ipset.add(oifIpsetName4, `0.0.0.0/1,${realIntf}`);
      Ipset.add(oifIpsetName4, `128.0.0.0/1,${realIntf}`);
      Ipset.add(oifIpsetName, oifIpsetName4);
      Ipset.add(oifIpsetName6, `::/1,${realIntf}`);
      Ipset.add(oifIpsetName6, `8000::/1,${realIntf}`);
      Ipset.add(oifIpsetName, oifIpsetName6);
      const rtIdHex = Number(this.o.rtid).toString(16);
      if (this.o.type === "wan" || hasDefaultRTSubnets) {
        // since hash:net does not allow /0 as cidr subnet, need to add two complementary entries to the ipset
        Ipset.add(hardRouteIpsetName4, `0.0.0.0/1`);
        Ipset.add(hardRouteIpsetName4, `128.0.0.0/1`);
        Ipset.add(hardRouteIpsetName6, `::/1`);
        Ipset.add(hardRouteIpsetName6, `8000::/1`);
        await this._enableDNSRoute("hard");
      }
      if (!_.isEmpty(this.o.rt4Subnets)) {
        for (const subnet of this.o.rt4Subnets)
          Ipset.add(hardRouteIpsetName4, subnet);
      }
      if (!_.isEmpty(this.o.rt6Subnets)) {
        for (const subnet of this.o.rt6Subnets)
          Ipset.add(hardRouteIpsetName6, subnet);
      }
      Ipset.add(hardRouteIpsetName, hardRouteIpsetName4, { skbmark: `0x${rtIdHex}/${routing.MASK_ALL}` });
      Ipset.add(hardRouteIpsetName, hardRouteIpsetName6, { skbmark: `0x${rtIdHex}/${routing.MASK_ALL}` });

      if (this.o.ready) {
        if (this.o.type === "wan" || hasDefaultRTSubnets) {
          Ipset.add(softRouteIpsetName4, `0.0.0.0/1`);
          Ipset.add(softRouteIpsetName4, `128.0.0.0/1`);
          Ipset.add(softRouteIpsetName6, `::/1`);
          Ipset.add(softRouteIpsetName6, `8000::/1`);
          await this._enableDNSRoute("soft");
        }
        if (!_.isEmpty(this.o.rt4Subnets)) {
          for (const subnet of this.o.rt4Subnets)
            Ipset.add(softRouteIpsetName4, subnet);
        }
        if (!_.isEmpty(this.o.rt6Subnets)) {
          for (const subnet of this.o.rt6Subnets)
            Ipset.add(softRouteIpsetName6, subnet);
        }
        Ipset.add(softRouteIpsetName, softRouteIpsetName4, { skbmark: `0x${rtIdHex}/${routing.MASK_ALL}` });
        Ipset.add(softRouteIpsetName, softRouteIpsetName6, { skbmark: `0x${rtIdHex}/${routing.MASK_ALL}` });
      }
    }
    // add server and mark directive for VPN interface with default route
    if (hasDefaultRTSubnets && this.isVPNInterface()) {
      const entries = [`mark=${this.o.rtid}$${NetworkProfile.getDnsMarkTag(this.o.uuid)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`];
      if (_.isArray(this.o.dns) && !_.isEmpty(this.o.dns)) {
        entries.push(`server=${this.o.dns[0]}$${NetworkProfile.getDnsMarkTag(this.o.uuid)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`);
      }
      await dnsmasq.writeConfig(this._getDnsmasqConfigPath(), entries).catch((err) => {});
    } else {
      await fs.unlinkAsync(this._getDnsmasqConfigPath()).catch((err) => {});
    }
  }

  async destroyEnv(options = {cleanup: false}) {
    let realIntf = this.o.intf;
    if (realIntf && realIntf.endsWith(":0"))
      realIntf = realIntf.substring(0, realIntf.length - 2);
    // remove WAN INPUT protection rules
    const inputRule = new Rule().chn("FW_INPUT_DROP").iif(realIntf).mdl("conntrack", "--ctstate INVALID").mdl("conntrack", "! --ctstate DNAT").jmp("DROP").comment(this.o.uuid);
    const inputRuleSec = new Rule().chn("FW_INPUT_DROP").iif(realIntf).mdl("conntrack", "--ctstate NEW").mdl("conntrack", "! --ctstate DNAT").jmp("FW_WAN_IN_DROP").comment(this.o.uuid);
    const inputRule6 = inputRule.clone().fam(6);
    const inputRule6Sec = inputRule.clone().fam(6);
    const invalidDropRule = new Rule().chn("FW_WAN_INVALID_DROP").oif(realIntf).jmp("DROP").comment(this.o.uuid);
    const invalidDropRule6 = invalidDropRule.clone().fam(6);

    const rules = [inputRule, inputRuleSec, inputRule6, inputRule6Sec, invalidDropRule, invalidDropRule6];
    rules.forEach(rule => iptc.addRule(rule.opr("-D")));

    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      if (options.cleanup) {
        Ipset.flush(netIpsetName);
        Ipset.flush(netIpsetName6);
        // although net ipset is already flushed, still remove it from c_lan_set anyway to keep consistency
        Ipset.del('c_lan_set', netIpsetName);
        Ipset.del('c_lan_set', netIpsetName6);
      }
      // remove from NAT hairpin chain anyway
      if (this.o.ipv4Subnets && this.o.ipv4Subnets.length != 0) {
        for (const subnet of this.o.ipv4Subnets) {
          const rule = new Rule("nat").chn("FW_POSTROUTING_HAIRPIN").src(subnet).jmp("MASQUERADE");
          iptc.addRule(rule.opr('-D'));
        }
      }
      if (options.cleanup) {
        // still remove it from monitored net set anyway to keep consistency
        Ipset.del(Ipset.CONSTANTS.IPSET_MONITORED_NET, netIpsetName);
        Ipset.del(Ipset.CONSTANTS.IPSET_MONITORED_NET, netIpsetName6);
      }
      // do not touch dnsmasq network config directory here, it should only be updated by rule enforcement modules
    }

    const GatewayIpsetName = NetworkProfile.getGatewayIpsetName(this.o.uuid);
    const GatewayIpsetName6 = NetworkProfile.getGatewayIpsetName(this.o.uuid, 6);
    if (!GatewayIpsetName || !GatewayIpsetName6) {
      log.error(`Failed to get gateway ipset name for ${this.o.uuid}`);
    } else {
      if (options.cleanup) {
        Ipset.flush(GatewayIpsetName);
        Ipset.flush(GatewayIpsetName6);
        // remove from c_network_gateway_set
        Ipset.del(Ipset.CONSTANTS.IPSET_NETWORK_GATEWAY_SET, GatewayIpsetName);
        Ipset.del(Ipset.CONSTANTS.IPSET_NETWORK_GATEWAY_SET, GatewayIpsetName6);
      }
    }

    const selfIpsetName = NetworkProfile.getSelfIpsetName(this.o.uuid);
    const selfIpsetName6 = NetworkProfile.getSelfIpsetName(this.o.uuid, 6);
    if (!selfIpsetName || !selfIpsetName6) {
      log.error(`Failed to get self ipset name for ${this.o.uuid}`);
    } else {
      Ipset.flush(selfIpsetName);
      Ipset.flush(selfIpsetName6);
    }

    const oifIpsetName = NetworkProfile.getOifIpsetName(this.o.uuid);
    const oifIpsetName4 = `${oifIpsetName}4`;
    const oifIpsetName6 = `${oifIpsetName}6`;
    Ipset.flush(oifIpsetName);
    Ipset.flush(oifIpsetName4);
    Ipset.flush(oifIpsetName6);
    const hardRouteIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid);
    const hardRouteIpsetName4 = `${hardRouteIpsetName}4`;
    const hardRouteIpsetName6 = `${hardRouteIpsetName}6`;
    const softRouteIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid, false);
    const softRouteIpsetName4 = `${softRouteIpsetName}4`;
    const softRouteIpsetName6 = `${softRouteIpsetName}6`;
    Ipset.flush(hardRouteIpsetName);
    Ipset.flush(hardRouteIpsetName4);
    Ipset.flush(hardRouteIpsetName6);
    Ipset.flush(softRouteIpsetName);
    Ipset.flush(softRouteIpsetName4);
    Ipset.flush(softRouteIpsetName6);
    await this._disableDNSRoute("hard");
    await this._disableDNSRoute("soft");
    await fs.unlinkAsync(this._getDnsmasqConfigPath()).catch((err) => {});
    this.oper = {}; // clear oper cache used in PolicyManager.js
    // disable spoof instances
    // use wildcard to deregister all spoof instances on this interface
    if (this.o.gateway) {
      await sm.deregisterSpoofInstance(this.o.intf, "*", false);
    }
    if (this.o.gateway6 && this.o.gateway6.length > 0) {
      await sm.deregisterSpoofInstance(this.o.intf, "*", true);
      this._monitoredGateway6 = [];
    }
    await sm.emptySpoofSet(this.o.intf);
    await dnsmasq.writeAllocationOption(this.o.intf, {})
  }

  async tags(tags, type = Constants.TAG_TYPE_GROUP) {
    const policyKey = _.get(Constants.TAG_TYPE_MAP, [type, "policyKey"]);
    if (!policyKey) {
      log.error(`Unknown tag type ${type}, ignore tags`, tags);
      return;
    }
    tags = (tags || []).map(String);
    this[`_${policyKey}`] = this[`_${policyKey}`] || [];
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for network profile ${this.o.uuid}`);
      return;
    }
    // remove old tags that are not in updated tags
    const removedTags = this[`_${policyKey}`].filter(uid => !(tags.includes(Number(uid)) || tags.includes(String(uid))));
    for (let removedTag of removedTags) {
      const tagExists = await TagManager.tagUidExists(removedTag, type);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(removedTag);
        Ipset.del(Tag.getTagSetName(removedTag), netIpsetName);
        Ipset.del(Tag.getTagSetName(removedTag), netIpsetName6);
        Ipset.del(Tag.getTagNetSetName(removedTag), netIpsetName);
        Ipset.del(Tag.getTagNetSetName(removedTag), netIpsetName6);
        await fs.unlinkAsync(`${NetworkProfile.getDnsmasqConfigDirectory(this.o.uuid)}/tag_${removedTag}_${this.o.uuid}.conf`).catch((err) => {});
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
        Ipset.add(Tag.getTagSetName(uid), netIpsetName);
        Ipset.add(Tag.getTagSetName(uid), netIpsetName6);
        Ipset.add(Tag.getTagNetSetName(uid), netIpsetName);
        Ipset.add(Tag.getTagNetSetName(uid), netIpsetName6);
        const dnsmasqEntry = `mac-address-group=%00:00:00:00:00:00@${uid}`;
        await dnsmasq.writeConfig(`${NetworkProfile.getDnsmasqConfigDirectory(this.o.uuid)}/tag_${uid}_${this.o.uuid}.conf`, dnsmasqEntry).catch((err) => {
          log.error(`Failed to write dnsmasq tag ${uid} on network ${this.o.uuid} ${this.o.intf}`, err);
        })
        updatedTags.push(uid);
      } else {
        log.warn(`Tag ${uid} not found`);
      }
    }
    this[`_${policyKey}`] = updatedTags;
    await this.setPolicyAsync(policyKey, this[`_${policyKey}`]); // keep tags in policy data up-to-date
    dnsmasq.scheduleRestartDNSService();
  }

  _getDnsmasqRouteConfigPath(routeType = "hard") {
    return `${f.getUserConfigFolder()}/dnsmasq/wan_${this.o.uuid}_${routeType}.conf`;
  }

  static getDnsMarkTag(uuid) {
    return `wan_${uuid}`;
  }

  _getDnsmasqConfigPath() {
    return `${f.getUserConfigFolder()}/dnsmasq/wan_${this.o.uuid}.conf`;
  }

  static getDNSRouteConfDir(uuid, routeType = "hard") {
    return `${f.getUserConfigFolder()}/dnsmasq/WAN:${uuid}_${routeType}`;
  }

  async _enableDNSRoute(routeType = "hard") {
    await dnsmasq.writeConfig(this._getDnsmasqRouteConfigPath(routeType), `conf-dir=${NetworkProfile.getDNSRouteConfDir(this.o.uuid, routeType)}`).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  async _disableDNSRoute(routeType = "hard") {
    await fs.unlinkAsync(this._getDnsmasqRouteConfigPath(routeType)).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  isReady() {
    return this.o.ready; 
  }
}

module.exports = NetworkProfile;
