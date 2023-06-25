/*    Copyright 2019-2023 Firewalla Inc.
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
const ipset = require('./Ipset.js');
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
const { wrapIptables } = require('./Iptables');
const Monitorable = require('./Monitorable');
const Constants = require('./Constants.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const { Address4, Address6 } = require('ip-address');

const instances = {}; // this instances cache can ensure that NetworkProfile object for each uuid will be created only once.
                      // it is necessary because each object will subscribe Network:PolicyChanged message.
                      // this can guarantee the event handler function is run on the correct and unique object.

const envCreatedMap = {};

class NetworkProfile extends Monitorable {
  static metaFieldsJson = ['dns', 'ipv4s', 'ipv4Subnets', 'ipv6', 'ipv6Subnets', 'monitoring', 'ready', 'active', 'pendingTest', 'rtid', 'origDns', 'rt4Subnets', 'rt6Subnets'];

  constructor(o) {
    if (!instances[o.uuid]) {
      super(o)
      this.policy = {};
      if (f.isMain()) {
        // o.monitoring indicates if this is a monitoring interface, this.spoofing may be set to false even if it is a monitoring interface
        this.spoofing = (o && o.monitoring) || false;
      }
      instances[o.uuid] = this;
      log.info('Created new Network:', this.getUniqueId())
    }
    return instances[o.uuid];
  }

  isVPNInterface() {
    return this.o.intf && (this.o.intf.startsWith("wg") || this.o.intf.startsWith("tun"));
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
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${netIpsetName}`).catch((err) => {
        log.error(`Failed to remove ${netIpsetName} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${netIpsetName6}`).catch((err) => {
        log.error(`Failed to remove ${netIpsetName6} from ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    } else {
      const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${netIpsetName}`).catch((err) => {
        log.error(`Failed to add ${netIpsetName} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_QOS_OFF} ${netIpsetName6}`).catch((err) => {
        log.error(`Failed to add ${netIpsetName6} to ${ipset.CONSTANTS.IPSET_QOS_OFF}`, err.message);
      });
    }
  }

  async acl(state) {
    if (state === true) {
      const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${netIpsetName}`).catch((err) => {
        log.error(`Failed to remove ${netIpsetName} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${netIpsetName6}`).catch((err) => {
        log.error(`Failed to remove ${netIpsetName6} from ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
    } else {
      const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${netIpsetName}`).catch((err) => {
        log.error(`Failed to add ${netIpsetName} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_ACL_OFF} ${netIpsetName6}`).catch((err) => {
        log.error(`Failed to add ${netIpsetName6} to ${ipset.CONSTANTS.IPSET_ACL_OFF}`, err.message);
      });
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
        const rule4 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 4)} src,src`);
        const rule6 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 6)} src,src`).fam(6);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uuid} ${this._profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uuid} ${this._profileId}`, err.message);
        });

        // remove rule that was set by state == null
        rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uuid} ${this._profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uuid} ${this._profileId}`, err.message);
        });
        
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

      if (state === true) {
        const rule4 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 4)} src,src`);
        const rule6 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 6)} src,src`).fam(6);
        await exec(rule4.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv4 vpn client rule for network ${this.o.uuid} ${profileId}`, err.message);
        });
        await exec(rule6.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv6 vpn client rule for network ${this.o.uuid} ${profileId}`, err.message);
        });

        // remove rule that was set by state == null
        rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uuid} ${this._profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uuid} ${this._profileId}`, err.message);
        });
        const markTag = `${profileId.startsWith("VWG:") ? VirtWanGroup.getDnsMarkTag(profileId.substring(4)) : VPNClient.getDnsMarkTag(profileId)}`;
        // use two config files, one in network directory, the other in vpn client hard route directory, the second file is controlled by conf-dir in VPNClient.js and will not be included when client is disconnected
        await fs.writeFileAsync(networkConfPath, `mac-address-tag=%00:00:00:00:00:00$vc_${this.o.uuid}`).catch((err) => {});
        await fs.writeFileAsync(vcConfPath, `tag-tag=$vc_${this.o.uuid}$${markTag}$!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // null means off
      if (state === null) {
        // remove rule that was set by state == true
        const rule4 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 4)} src,src`);
        const rule6 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 6)} src,src`).fam(6);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for network ${this.o.uuid} ${profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for network ${this.o.uuid} ${profileId}`, err.message);
        });
        // override target and clear vpn client bits in fwmark
        rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(rule4.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv4 vpn client rule for network ${this.o.uuid} ${profileId}`, err.message);
        });
        await exec(rule6.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv6 vpn client rule for network ${this.o.uuid} ${profileId}`, err.message);
        });
        await fs.writeFileAsync(networkConfPath, `mac-address-tag=%00:00:00:00:00:00$vc_${this.o.uuid}`).catch((err) => {});
        await fs.writeFileAsync(vcConfPath, `tag-tag=$vc_${this.o.uuid}$${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // false means N/A
      if (state === false) {
        const rule4 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 4)} src,src`);
        const rule6 = rule.clone().mdl("set", `--match-set ${NetworkProfile.getNetIpsetName(this.o.uuid, 6)} src,src`).fam(6);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for network ${this.o.uuid} ${profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for network ${this.o.uuid} ${profileId}`, err.message);
        });

        // remove rule that was set by state == null
        rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(rule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uuid} ${this._profileId}`, err.message);
        });
        await exec(rule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uuid} ${this._profileId}`, err.message);
        });
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
      let cmd =  `sudo ipset del -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${netIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${netIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset del -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${netIpsetName6}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${netIpsetName6} ${this.o.intf}`, err);
      });
    } else {
      let cmd =  `sudo ipset add -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${netIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${netIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset add -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${netIpsetName6}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${netIpsetName6} ${this.o.intf}`, err);
      });
    }
  }

  static async destroyBakChains() {
    await exec(wrapIptables(`sudo iptables -w -D INPUT -j FW_INPUT_ACCEPT_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo ip6tables -w -D INPUT -j FW_INPUT_ACCEPT_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo iptables -w -D INPUT -j FW_INPUT_DROP_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo ip6tables -w -D INPUT -j FW_INPUT_DROP_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo iptables -w -F FW_INPUT_ACCEPT_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo ip6tables -w -F FW_INPUT_ACCEPT_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo iptables -w -F FW_INPUT_DROP_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo ip6tables -w -F FW_INPUT_DROP_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo iptables -w -X FW_INPUT_ACCEPT_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo ip6tables -w -X FW_INPUT_ACCEPT_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo iptables -w -X FW_INPUT_DROP_BAK`)).catch((err) => {});
    await exec(wrapIptables(`sudo ip6tables -w -X FW_INPUT_DROP_BAK`)).catch((err) => {});
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

  isDefaultRoute(cidr) {
    let addr = new Address4(cidr);
    if (addr.isValid() && addr.subnetMask == 0) {
      return true;
    } else {
      addr = new Address6(cidr);
      if (addr.isValid() && addr.subnetMask == 0)
        return true;
    }
    return false;
  }

  // This function can be called while enforcing rules on network.
  // In case the network doesn't exist at the time when policy is enforced, but may be restored from config history in future.
  // Thereby, the rule can still be applied and take effect once the network is restored
  static async ensureCreateEnforcementEnv(uuid) {
    await lock.acquire(`NET_ENFORCE_${uuid}`, async() => {
      if (envCreatedMap[uuid])
        return;
      const netIpsetName = NetworkProfile.getNetIpsetName(uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(uuid, 6);
      if (!netIpsetName || !netIpsetName6) {
        log.error(`Failed to get ipset name for ${uuid}`);
      } else {
        await exec(`sudo ipset create -! ${netIpsetName} hash:net,iface maxelem 1024`).catch((err) => {
          log.error(`Failed to create network profile ipset ${netIpsetName}`, err.message);
        });
        await exec(`sudo ipset create -! ${netIpsetName6} hash:net,iface family inet6 maxelem 1024`).catch((err) => {
          log.error(`Failed to create network profile ipset ${netIpsetName6}`, err.message);
        });
      }
      const selfIpsetName = NetworkProfile.getSelfIpsetName(uuid);
      const selfIpsetName6 = NetworkProfile.getSelfIpsetName(uuid, 6);
      if (!selfIpsetName || !selfIpsetName6) {
        log.error(`Failed to get self ipset name for ${uuid}`);
      } else {
        await exec(`sudo ipset create -! ${selfIpsetName} hash:ip maxelem 32`).catch((err) => {
          log.error(`Failed to create network profile self ipset ${selfIpsetName}`, err.message);
        });
        await exec(`sudo ipset create -! ${selfIpsetName6} hash:ip family inet6 maxelem 32`).catch((err) => {
          log.error(`Failed to create network profile self ipset ${selfIpsetName6}`, err.message);
        });
      }
      // routing ipset with skbmark extensions
      const hardRouteIpsetName = NetworkProfile.getRouteIpsetName(uuid);
      const hardRouteIpsetName4 = `${hardRouteIpsetName}4`;
      const hardRouteIpsetName6 = `${hardRouteIpsetName}6`;
      await exec(`sudo ipset create -! ${hardRouteIpsetName} list:set skbinfo`).catch((err) => {
        log.error(`Failed to create network profile routing ipset ${hardRouteIpsetName}`, err.message);
      });
      await exec(`sudo ipset create -! ${hardRouteIpsetName4} hash:net maxelem 1024`).catch((err) => {
        log.error(`Failed to create network profile routing ipset ${hardRouteIpsetName4}`, err.message);
      });
      await exec(`sudo ipset create -! ${hardRouteIpsetName6} hash:net family inet6 maxelem 1024`).catch((err) => {
        log.error(`Failed to create network profile ipset ${hardRouteIpsetName6}`, err.message);
      });

      const softRouteIpsetName = NetworkProfile.getRouteIpsetName(uuid, false);
      const softRouteIpsetName4 = `${softRouteIpsetName}4`;
      const softRouteIpsetName6 = `${softRouteIpsetName}6`;
      await exec(`sudo ipset create -! ${softRouteIpsetName} list:set skbinfo`).catch((err) => {
        log.error(`Failed to create network profile routing ipset ${softRouteIpsetName}`, err.message);
      });
      await exec(`sudo ipset create -! ${softRouteIpsetName4} hash:net maxelem 1024`).catch((err) => {
        log.error(`Failed to create network profile routing ipset ${softRouteIpsetName4}`, err.message);
      });
      await exec(`sudo ipset create -! ${softRouteIpsetName6} hash:net family inet6 maxelem 1024`).catch((err) => {
        log.error(`Failed to create network profile routing ipset ${softRouteIpsetName6}`, err.message);
      });

      const oifIpsetName = NetworkProfile.getOifIpsetName(uuid);
      const oifIpsetName4 = `${oifIpsetName}4`;
      const oifIpsetName6 = `${oifIpsetName}6`;
      await exec(`sudo ipset create -! ${oifIpsetName} list:set`).catch((err) => {
        log.error(`Failed to create network profile oif ipset ${oifIpsetName}`, err.message);
      });
      await exec(`sudo ipset create -! ${oifIpsetName4} hash:net,iface maxelem 10`).catch((err) => {
        log.error(`Failed to create network profile oif ipset ${oifIpsetName4}`, err.message);
      });
      await exec(`sudo ipset create -! ${oifIpsetName6} hash:net,iface family inet6 maxelem 10`).catch((err) => {
        log.error(`Failed to create network profile oif ipset ${oifIpsetName6}`, err.message);
      });

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
    const inputRule = new Rule().chn("FW_INPUT_DROP").mth(realIntf, null, "iif").mdl("conntrack", "--ctstate INVALID").mdl("conntrack", "! --ctstate DNAT").jmp("DROP").mdl("comment", `--comment ${this.o.uuid}`);
    const inputRuleSec = new Rule().chn("FW_INPUT_DROP").mth(realIntf, null, "iif").mdl("conntrack", "--ctstate NEW").mdl("conntrack", "! --ctstate DNAT").jmp("FW_WAN_IN_DROP").mdl("comment", `--comment ${this.o.uuid}`);
    const inputRule6 = inputRule.clone().fam(6);
    const inputRule6Sec = inputRuleSec.clone().fam(6);
    const invalidDropRule = new Rule().chn("FW_WAN_INVALID_DROP").mth(realIntf, null, "oif").jmp("DROP").mdl("comment", `--comment ${this.o.uuid}`);
    const invalidDropRule6 = invalidDropRule.clone().fam(6);
    if (this.o.type === "wan" && await Mode.isRouterModeOn()) {
      // add DROP rule on WAN interface in router mode
      await exec(inputRule.toCmd("-A")).catch((err) => {
        log.error(`Failed to add IPv4 DROP rule to INPUT for WAN interface ${realIntf}`, err.message);
      });
      await exec(inputRuleSec.toCmd("-A")).catch((err) => {
        log.error(`Failed to add IPv4 DROP rule to INPUT for WAN interface ${realIntf}`, err.message);
      });
      await exec(inputRule6.toCmd("-A")).catch((err) => {
        log.error(`Failed to add IPv6 DROP rule to INPUT for WAN interface ${realIntf}`, err.message);
      });
      await exec(inputRule6Sec.toCmd("-A")).catch((err) => {
        log.error(`Failed to add IPv6 DROP rule to INPUT for WAN interface ${realIntf}`, err.message);
      });
      await exec(invalidDropRule.toCmd("-A")).catch((err) => {
        log.error(`Failed to add IPv4 invalid forward DROP rule for WAN interface ${realIntf}`, err.message);
      });
      await exec(invalidDropRule6.toCmd("-A")).catch((err) => {
        log.error(`Failed to add IPv6 invalid forward DROP rule for WAN interface ${realIntf}`, err.message);
      });
    } else {
      await exec(inputRule.toCmd("-D")).catch((err) => {});
      await exec(inputRuleSec.toCmd("-D")).catch((err) => {});
      await exec(inputRule6.toCmd("-D")).catch((err) => {});
      await exec(inputRule6Sec.toCmd("-D")).catch((err) => {});
      await exec(invalidDropRule.toCmd("-D")).catch((err) => {});
      await exec(invalidDropRule6.toCmd("-D")).catch((err) => {});
    }
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    let hasDefaultRTSubnets = false;
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset flush -! ${netIpsetName}`).then(async () => {
        if (this.o && this.o.monitoring === true) {
          if (_.isArray(this.o.ipv4Subnets)) {
            for (const subnet of this.o.ipv4Subnets)
              await exec(`sudo ipset add -! ${netIpsetName} ${subnet},${realIntf}`);
          }
          if (_.isArray(this.o.rt4Subnets)) {
            for (const subnet of this.o.rt4Subnets) {
              if (!this.isDefaultRoute(subnet))
                await exec(`sudo ipset add -! ${netIpsetName} ${subnet},${realIntf}`);
              else
                hasDefaultRTSubnets = true;
            }
          }
        }
      }).catch((err) => {
        log.error(`Failed to populate network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset flush -! ${netIpsetName6}`).then(async () => {
        if (this.o && this.o.monitoring === true) {
          if (_.isArray(this.o.ipv6Subnets)) {
            for (const subnet6 of this.o.ipv6Subnets)
              await exec(`sudo ipset add -! ${netIpsetName6} ${subnet6},${realIntf}`).catch((err) => {});
          }
          if (_.isArray(this.o.rt6Subnets)) {
            for (const subnet6 of this.o.rt6Subnets) {
              if (!this.isDefaultRoute(subnet6))
                await exec(`sudo ipset add -! ${netIpsetName6} ${subnet6},${realIntf}`).catch((err) => {});
              else
                hasDefaultRTSubnets = true;
            }
          }
        }
      }).catch((err) => {
        log.error(`Failed to populate network profile ipset ${netIpsetName6}`, err.message);
      });
      // add to c_lan_set accordingly, some feature has mandatory to be enabled on lan only, e.g., vpn client
      let op = "del"
      if (this.o.type === "lan" && this.o.monitoring === true)
        op = "add"
      await exec(`sudo ipset ${op} -! c_lan_set ${netIpsetName}`).then(() => {
        return exec(`sudo ipset ${op} -! c_lan_set ${netIpsetName6}`);
      }).catch((err) => {
        log.error(`Failed to ${op} ${netIpsetName}(6) to c_lan_set`, err.message);
      });
      // add to NAT hairpin chain if it is LAN network
      if (this.o.ipv4Subnets && this.o.ipv4Subnets.length != 0) {
        for (const subnet of this.o.ipv4Subnets) {
          const rule = new Rule("nat").chn("FW_POSTROUTING_HAIRPIN").mth(`${subnet}`, null, "src").jmp("MASQUERADE");
          if (this.o.type === "lan" && this.o.monitoring === true) {
            await exec(rule.toCmd('-A')).catch((err) => {
              log.error(`Failed to add NAT hairpin rule for ${this.o.intf}, ${this.o.uuid}`);
            });
          } else {
            await exec(rule.toCmd('-D')).catch((err) => {});
          }
        }
      }
      // add to monitored net ipset accordingly
      op = "del";
      if (this.o.monitoring === true)
        op = "add";
      await exec(`sudo ipset ${op} -! ${ipset.CONSTANTS.IPSET_MONITORED_NET} ${netIpsetName}`).then(() => {
        return exec(`sudo ipset ${op} -! ${ipset.CONSTANTS.IPSET_MONITORED_NET} ${netIpsetName6}`);
      }).catch((err) => {
        log.error(`Failed to ${op} ${netIpsetName}(6) to ${ipset.CONSTANTS.IPSET_MONITORED_NET}`, err.message);
      });
    }

    const selfIpsetName = NetworkProfile.getSelfIpsetName(this.o.uuid);
    const selfIpsetName6 = NetworkProfile.getSelfIpsetName(this.o.uuid, 6);
    if (!selfIpsetName || !selfIpsetName6) {
      log.error(`Failed to get self ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset flush -! ${selfIpsetName}`).then(async () => {
        if (this.o && _.isArray(this.o.ipv4s)) {
          for (const ip4 of this.o.ipv4s)
            await exec(`sudo ipset add -! ${selfIpsetName} ${ip4}`);
        }
      }).catch((err) => {
        log.error(`Failed to populate network profile self ipset ${selfIpsetName}`, err.message);
      });
      await exec(`sudo ipset flush -! ${selfIpsetName6}`).then(async () => {
        if (this.o && _.isArray(this.o.ipv6)) {
          for (const ip6 of this.o.ipv6)
            await exec(`sudo ipset add -! ${selfIpsetName6} ${ip6}`).catch((err) => {});
        }
      }).catch((err) => {
        log.error(`Failed to populate network profile self ipset ${selfIpsetName6}`, err.message);
      });
    }

    const oifIpsetName = NetworkProfile.getOifIpsetName(this.o.uuid);
    const oifIpsetName4 = `${oifIpsetName}4`;
    const oifIpsetName6 = `${oifIpsetName}6`;
    await exec(`sudo ipset flush -! ${oifIpsetName}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${oifIpsetName4}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${oifIpsetName6}`).catch((err) => {});

    const hardRouteIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid);
    const hardRouteIpsetName4 = `${hardRouteIpsetName}4`;
    const hardRouteIpsetName6 = `${hardRouteIpsetName}6`;
    const softRouteIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid, false);
    const softRouteIpsetName4 = `${softRouteIpsetName}4`;
    const softRouteIpsetName6 = `${softRouteIpsetName}6`;
    await exec(`sudo ipset flush -! ${hardRouteIpsetName}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${hardRouteIpsetName4}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${hardRouteIpsetName6}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${softRouteIpsetName}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${softRouteIpsetName4}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${softRouteIpsetName6}`).catch((err) => {});
    await this._disableDNSRoute("soft");
    await this._disableDNSRoute("hard");

    if (this.o.type === "wan" || !_.isEmpty(this.o.rt4Subnets) || !_.isEmpty(this.o.rt6Subnets)) {
      await exec(`sudo ipset add -! ${oifIpsetName4} 0.0.0.0/1,${realIntf}`).catch((err) => {});
      await exec(`sudo ipset add -! ${oifIpsetName4} 128.0.0.0/1,${realIntf}`).catch((err) => {});
      await exec(`sudo ipset add -! ${oifIpsetName} ${oifIpsetName4}`).catch((err) => {});
      await exec(`sudo ipset add -! ${oifIpsetName6} ::/1,${realIntf}`).catch((err) => {});
      await exec(`sudo ipset add -! ${oifIpsetName6} 8000::/1,${realIntf}`).catch((err) => {});
      await exec(`sudo ipset add -! ${oifIpsetName} ${oifIpsetName6}`).catch((err) => {});
      const rtIdHex = Number(this.o.rtid).toString(16);
      if (this.o.type === "wan" || hasDefaultRTSubnets) {
        // since hash:net does not allow /0 as cidr subnet, need to add two complementary entries to the ipset
        await exec(`sudo ipset add -! ${hardRouteIpsetName4} 0.0.0.0/1`).catch((err) => {
          log.error(`Failed to add 0.0.0.0/1 to ${hardRouteIpsetName4}`, err.message);
        });
        await exec(`sudo ipset add -! ${hardRouteIpsetName4} 128.0.0.0/1`).catch((err) => {
          log.error(`Failed to add 128.0.0.0/1 to ${hardRouteIpsetName4}`, err.message);
        });
        await exec(`sudo ipset add -! ${hardRouteIpsetName6} ::/1`).catch((err) => {
          log.error(`Failed to add ::/1 to ${hardRouteIpsetName6}`, err.message);
        });
        await exec(`sudo ipset add -! ${hardRouteIpsetName6} 8000::/1`).catch((err) => {
          log.error(`Failed to add 8000::/1 to ${hardRouteIpsetName6}`, err.message);
        });
        await this._enableDNSRoute("hard");
      }
      if (!_.isEmpty(this.o.rt4Subnets)) {
        for (const subnet of this.o.rt4Subnets)
          await exec(`sudo ipset add -! ${hardRouteIpsetName4} ${subnet}`).catch((err) => {});
      }
      if (!_.isEmpty(this.o.rt6Subnets)) {
        for (const subnet of this.o.rt6Subnets)
          await exec(`sudo ipset add -! ${hardRouteIpsetName6} ${subnet}`).catch((err) => {});
      }
      await exec(`sudo ipset add -! ${hardRouteIpsetName} ${hardRouteIpsetName4} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {
        log.error(`Failed to add ipv4 route set ${hardRouteIpsetName4} skbmark 0x${rtIdHex}/${routing.MASK_ALL} to ${hardRouteIpsetName}`, err.message);
      });
      await exec(`sudo ipset add -! ${hardRouteIpsetName} ${hardRouteIpsetName6} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {
        log.error(`Failed to add ipv6 route set ${hardRouteIpsetName6} skbmark 0x${rtIdHex}/${routing.MASK_ALL} to ${hardRouteIpsetName}`, err.message);
      });

      if (this.o.ready) {
        if (this.o.type === "wan" || hasDefaultRTSubnets) {
          await exec(`sudo ipset add -! ${softRouteIpsetName4} 0.0.0.0/1`).catch((err) => {
            log.error(`Failed to add 0.0.0.0/1 to ${softRouteIpsetName4}`, err.message);
          });
          await exec(`sudo ipset add -! ${softRouteIpsetName4} 128.0.0.0/1`).catch((err) => {
            log.error(`Failed to add 128.0.0.0/1 to ${softRouteIpsetName4}`, err.message);
          });
          await exec(`sudo ipset add -! ${softRouteIpsetName6} ::/1`).catch((err) => {
            log.error(`Failed to add ::/1 to ${softRouteIpsetName6}`, err.message);
          });
          await exec(`sudo ipset add -! ${softRouteIpsetName6} 8000::/1`).catch((err) => {
            log.error(`Failed to add 8000::/1 to ${softRouteIpsetName6}`, err.message);
          });
          await this._enableDNSRoute("soft");
        }
        if (!_.isEmpty(this.o.rt4Subnets)) {
          for (const subnet of this.o.rt4Subnets)
            await exec(`sudo ipset add -! ${softRouteIpsetName4} ${subnet}`).catch((err) => {});
        }
        if (!_.isEmpty(this.o.rt6Subnets)) {
          for (const subnet of this.o.rt6Subnets)
            await exec(`sudo ipset add -! ${softRouteIpsetName6} ${subnet}`).catch((err) => {});
        }
        await exec(`sudo ipset add -! ${softRouteIpsetName} ${softRouteIpsetName4} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {
          log.error(`Failed to add ipv4 route set ${softRouteIpsetName4} skbmark 0x${rtIdHex}/${routing.MASK_ALL} to ${softRouteIpsetName}`, err.message);
        });
        await exec(`sudo ipset add -! ${softRouteIpsetName} ${softRouteIpsetName6} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {
          log.error(`Failed to add ipv6 route set ${softRouteIpsetName6} skbmark 0x${rtIdHex}/${routing.MASK_ALL} to ${softRouteIpsetName}`, err.message);
        });
      }
    }
    // add server and mark directive for VPN interface with default route
    if (hasDefaultRTSubnets && this.isVPNInterface()) {
      const entries = [`mark=${this.o.rtid}$${NetworkProfile.getDnsMarkTag(this.o.uuid)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`];
      if (_.isArray(this.o.dns) && !_.isEmpty(this.o.dns)) {
        entries.push(`server=${this.o.dns[0]}$${NetworkProfile.getDnsMarkTag(this.o.uuid)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`);
      }
      await fs.writeFileAsync(this._getDnsmasqConfigPath(), entries.join('\n')).catch((err) => {});
    } else {
      await fs.unlinkAsync(this._getDnsmasqConfigPath()).catch((err) => {});
    }
  }

  async destroyEnv() {
    let realIntf = this.o.intf;
    if (realIntf && realIntf.endsWith(":0"))
      realIntf = realIntf.substring(0, realIntf.length - 2);
    // remove WAN INPUT protection rules
    const inputRule = new Rule().chn("FW_INPUT_DROP").mth(realIntf, null, "iif").mdl("conntrack", "--ctstate INVALID").mdl("conntrack", "! --ctstate DNAT").jmp("DROP").mdl("comment", `--comment ${this.o.uuid}`);
    const inputRuleSec = new Rule().chn("FW_INPUT_DROP").mth(realIntf, null, "iif").mdl("conntrack", "--ctstate NEW").mdl("conntrack", "! --ctstate DNAT").jmp("FW_WAN_IN_DROP").mdl("comment", `--comment ${this.o.uuid}`);
    const inputRule6 = inputRule.clone().fam(6);
    const inputRule6Sec = inputRule.clone().fam(6);
    const invalidDropRule = new Rule().chn("FW_WAN_INVALID_DROP").mth(realIntf, null, "oif").jmp("DROP").mdl("comment", `--comment ${this.o.uuid}`);
    const invalidDropRule6 = invalidDropRule.clone().fam(6);
    await exec(inputRule.toCmd("-D")).catch((err) => {});
    await exec(inputRuleSec.toCmd("-D")).catch((err) => {});
    await exec(inputRule6.toCmd("-D")).catch((err) => {});
    await exec(inputRule6Sec.toCmd("-D")).catch((err) => {});
    await exec(invalidDropRule.toCmd("-D")).catch((err) => {});
    await exec(invalidDropRule6.toCmd("-D")).catch((err) => {});

    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset flush -! ${netIpsetName}`).catch((err) => {
        log.debug(`Failed to flush network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset flush -! ${netIpsetName6}`).catch((err) => {
        log.debug(`Failed to flush network profile ipset ${netIpsetName6}`, err.message);
      });
      // although net ipset is already flushed, still remove it from c_lan_set anyway to keep consistency
      await exec(`sudo ipset del -! c_lan_set ${netIpsetName}`).catch((err) => {
        log.debug(`Failed to remove ${netIpsetName} from c_lan_set`, err.message);
      });
      await exec(`sudo ipset del -! c_lan_set ${netIpsetName6}`).catch((err) => {
        log.debug(`Failed to remove ${netIpsetName6} from c_lan_set`, err.message);
      });
      // remove from NAT hairpin chain anyway
      if (this.o.ipv4Subnets && this.o.ipv4Subnets.length != 0) {
        for (const subnet of this.o.ipv4Subnets) {
          const rule = new Rule("nat").chn("FW_POSTROUTING_HAIRPIN").mth(`${subnet}`, null, "src").jmp("MASQUERADE");
          await exec(rule.toCmd('-D')).catch((err) => {});
        }
      }
      // still remove it from monitored net set anyway to keep consistency
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_MONITORED_NET} ${netIpsetName}`).catch((err) => {
        log.debug(`Failed to remove ${netIpsetName} from ${ipset.CONSTANTS.IPSET_MONITORED_NET}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_MONITORED_NET} ${netIpsetName6}`).catch((err) => {
        log.debug(`Failed to remove ${netIpsetName6} from ${ipset.CONSTANTS.IPSET_MONITORED_NET}`, err.message);
      });
      // do not touch dnsmasq network config directory here, it should only be updated by rule enforcement modules
    }

    const selfIpsetName = NetworkProfile.getSelfIpsetName(this.o.uuid);
    const selfIpsetName6 = NetworkProfile.getSelfIpsetName(this.o.uuid, 6);
    if (!selfIpsetName || !selfIpsetName6) {
      log.error(`Failed to get self ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset flush -! ${selfIpsetName}`).catch((err) => {
        log.debug(`Failed to flush network profile self ipset ${selfIpsetName}`, err.message);
      });
      await exec(`sudo ipset flush -! ${selfIpsetName6}`).catch((err) => {
        log.debug(`Failed to flush network profile self ipset ${selfIpsetName6}`, err.message);
      });
    }

    const oifIpsetName = NetworkProfile.getOifIpsetName(this.o.uuid);
    const oifIpsetName4 = `${oifIpsetName}4`;
    const oifIpsetName6 = `${oifIpsetName}6`;
    await exec(`sudo ipset flush -! ${oifIpsetName}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${oifIpsetName4}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${oifIpsetName6}`).catch((err) => {});
    const hardRouteIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid);
    const hardRouteIpsetName4 = `${hardRouteIpsetName}4`;
    const hardRouteIpsetName6 = `${hardRouteIpsetName}6`;
    const softRouteIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid, false);
    const softRouteIpsetName4 = `${softRouteIpsetName}4`;
    const softRouteIpsetName6 = `${softRouteIpsetName}6`;
    await exec(`sudo ipset flush -! ${hardRouteIpsetName}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${hardRouteIpsetName4}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${hardRouteIpsetName6}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${softRouteIpsetName}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${softRouteIpsetName4}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${softRouteIpsetName6}`).catch((err) => {});
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

  getTags() {
    if (_.isEmpty(this._tags)) {
      return [];
    }

    return this._tags;
  }

  async tags(tags) {
    tags = tags || [];
    this._tags = this._tags || [];
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for network profile ${this.o.uuid}`);
      return;
    }
    // remove old tags that are not in updated tags
    const removedTags = this._tags.filter(uid => !(tags.includes(Number(uid)) || tags.includes(String(uid))));
    for (let removedTag of removedTags) {
      const tagExists = await TagManager.tagUidExists(removedTag);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(removedTag);
        await exec(`sudo ipset del -! ${Tag.getTagSetName(removedTag)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset del -! ${Tag.getTagSetName(removedTag)} ${netIpsetName6}`);
        }).catch((err) => {
          log.error(`Failed to remove ${netIpsetName}(6) from ${Tag.getTagSetName(removedTag)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        await exec(`sudo ipset del -! ${Tag.getTagNetSetName(removedTag)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset del -! ${Tag.getTagNetSetName(removedTag)} ${netIpsetName6}`);
        }).catch((err) => {
          log.error(`Failed to remove ${netIpsetName}(6) from ${Tag.getTagNetSetName(removedTag)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        await fs.unlinkAsync(`${NetworkProfile.getDnsmasqConfigDirectory(this.o.uuid)}/tag_${removedTag}_${this.o.uuid}.conf`).catch((err) => {});
      } else {
        log.warn(`Tag ${removedTag} not found`);
      }
    }
    // filter updated tags in case some tag is already deleted from system
    const updatedTags = [];
    for (let uid of tags) {
      const tagExists = await TagManager.tagUidExists(uid);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(uid);
        await exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${netIpsetName6}`);
        }).catch((err) => {
          log.error(`Failed to add ${netIpsetName}(6) to ${Tag.getTagSetName(uid)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        await exec(`sudo ipset add -! ${Tag.getTagNetSetName(uid)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset add -! ${Tag.getTagNetSetName(uid)} ${netIpsetName6}`);
        }).catch((err) => {
          log.error(`Failed to add ${netIpsetName}(6) to ${Tag.getTagNetSetName(uid)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        const dnsmasqEntry = `mac-address-group=%00:00:00:00:00:00@${uid}`;
        await fs.writeFileAsync(`${NetworkProfile.getDnsmasqConfigDirectory(this.o.uuid)}/tag_${uid}_${this.o.uuid}.conf`, dnsmasqEntry).catch((err) => {
          log.error(`Failed to write dnsmasq tag ${uid} on network ${this.o.uuid} ${this.o.intf}`, err);
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
    await fs.writeFileAsync(this._getDnsmasqRouteConfigPath(routeType), `conf-dir=${NetworkProfile.getDNSRouteConfDir(this.o.uuid, routeType)}`).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  async _disableDNSRoute(routeType = "hard") {
    await fs.unlinkAsync(this._getDnsmasqRouteConfigPath(routeType)).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }
}

module.exports = NetworkProfile;
