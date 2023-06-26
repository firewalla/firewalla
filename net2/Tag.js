/*    Copyright 2020-2023 Firewalla Inc.
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
const exec = require('child-process-promise').exec;
const VPNClient = require('../extension/vpnclient/VPNClient.js');
const VirtWanGroup = require('./VirtWanGroup.js');
const { Rule } = require('./Iptables.js');
const fs = require('fs');
const Promise = require('bluebird');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const routing = require('../extension/routing/routing.js');
const dnsmasq = new DNSMASQ();
const Monitorable = require('./Monitorable');
const Constants = require('./Constants.js');
Promise.promisifyAll(fs);

const instances = {};
const envCreatedMap = {};


class Tag extends Monitorable {
  constructor(o) {
    if (!instances[o.uid]) {
      super(o)
      instances[o.uid] = this
      log.info('Created new Tag:', this.getUniqueId())
    }
    return instances[o.uid]
  }

  getUniqueId() {
    return this.o.uid
  }

  setTagName(name) {
    this.o.name = name;
  }

  getTagName() {
    return this.o.name;
  }

  getReadableName() {
    return this.o.name || super.getReadableName()
  }

  getTagUid() {
    return this.o.uid;
  }

  getMetaKey() {
    return "tag:uid:" + this.getGUID()
  }

  _getPolicyKey() {
    return `policy:tag:${this.o.uid}`;
  }

  // this can be used to match everything on this tag, including device and network
  static getTagSetName(uid) {
    return `c_tag_${uid}_set`;
  }

  // this can be used to match device alone on this tag
  static getTagDeviceMacSetName(uid) {
    return `c_tag_${uid}_dev_mac_set`
  }

  // this can be used to match network alone on this tag
  static getTagNetSetName(uid) {
    return `c_tag_${uid}_net_set`;
  }

  // this can be used to match mac as well as IP of device on this tag
  static getTagDeviceSetName(uid) {
    return `c_tag_${uid}_dev_set`;
  }

  static async ensureCreateEnforcementEnv(uid) {
    if (envCreatedMap[uid])
      return;
    // create related ipsets
    await exec(`sudo ipset create -! ${Tag.getTagSetName(uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag ipset ${Tag.getTagSetName(uid)}`, err.message);
    });
    await exec(`sudo ipset create -! ${Tag.getTagDeviceMacSetName(uid)} hash:mac`).catch((err) => {
      log.error(`Failed to create tag mac ipset ${Tag.getTagDeviceMacSetName(uid)}`, err.message);
    });
    await exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${Tag.getTagDeviceMacSetName(uid)}`).catch((err) => {
      log.error(`Failed to add ${Tag.getTagDeviceMacSetName(uid)} to ipset ${Tag.getTagSetName(uid)}`, err.message);
    });
    // you may think this tag net set is redundant? 
    // it is needed to apply fine-grained policy on tag level. e.g., customized wan, QoS
    await exec(`sudo ipset create -! ${Tag.getTagNetSetName(uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag net ipset ${Tag.getTagNetSetName(uid)}`, err.message);
    });
    // it can be used to match src,dst on devices in the group
    await exec(`sudo ipset create -! ${Tag.getTagDeviceSetName(uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag mac tracking ipset ${Tag.getTagDeviceSetName(uid)}`, err.message);
    });
    await exec(`sudo ipset add -! ${Tag.getTagDeviceSetName(uid)} ${Tag.getTagDeviceMacSetName(uid)}`).catch((err) => {
      log.error(`Failed to add ${Tag.getTagDeviceMacSetName(uid)} to ${Tag.getTagDeviceSetName(uid)}`, err.message);
    });
    envCreatedMap[uid] = 1;
  }

  async createEnv() {
    await Tag.ensureCreateEnforcementEnv(this.o.uid);
  }

  async destroyEnv() {
    const PM2 = require('../alarm/PolicyManager2.js');
    const pm2 = new PM2();
    await pm2.deleteTagRelatedPolicies(this.o.uid);
    const EM = require('../alarm/ExceptionManager.js');
    const em = new EM();
    await em.deleteTagRelatedExceptions(this.o.uid);

    const FlowAggrTool = require('../net2/FlowAggrTool');
    const flowAggrTool = new FlowAggrTool();

    await flowAggrTool.removeAggrFlowsAllTag(this.o.uid);

    // flush related ipsets
    await exec(`sudo ipset flush -! ${Tag.getTagSetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag ipset ${Tag.getTagSetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagDeviceMacSetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag mac ipset ${Tag.getTagDeviceMacSetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagNetSetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag net ipset ${Tag.getTagNetSetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagDeviceSetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag mac tracking ipset ${Tag.getTagDeviceSetName(this.o.uid)}`, err.message);
    });
    // delete related dnsmasq config files
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}_*`).catch((err) => {}); // delete files in global effective directory
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/*/tag_${this.o.uid}_*`).catch((err) => {}); // delete files in network-wise effective directories
    dnsmasq.scheduleRestartDNSService();
  }

  async ipAllocation(policy) {
    await dnsmasq.writeAllocationOption(this.getUniqueId(), policy, true)
  }

  async qos(state) {
    // do nothing for qos on tag
  }

  async acl(state) {
    // do nothing for acl on tag
  }

  async spoof(state) {
    // do nothing for spoof on tag
  }

  async shield(policy) {
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
      const tagConfPath = `${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}_vc.conf`;
      if (this._profileId && profileId !== this._profileId) {
        log.info(`Current VPN profile id is different from the previous profile id ${this._profileId}, remove old rule on tag ${this.o.uid}`);
        const rule = new Rule("mangle")
          .jmp(`SET --map-set ${this._profileId.startsWith("VWG:") ? VirtWanGroup.getRouteIpsetName(this._profileId.substring(4)) : VPNClient.getRouteIpsetName(this._profileId)} dst,dst --map-mark`)
          .comment(`policy:tag:${this.o.uid}`);
        const devRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5");
        const devRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5").fam(6);
        const netRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagNetSetName(this.o.uid)} src,src`).chn("FW_RT_TAG_NETWORK_5");
        const netRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagNetSetName(this.o.uid)} src,src`).chn("FW_RT_TAG_NETWORK_5").fam(6);

        await exec(devRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(devRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });

        // remove rule that was set by state == null
        devRule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        devRule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        netRule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        netRule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(devRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(devRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });

        const vcConfPath = this._profileId.startsWith("VWG:") ? `${VirtWanGroup.getDNSRouteConfDir(this._profileId.substring(4), "hard")}/tag_${this.o.uid}_vc.conf` : `${VPNClient.getDNSRouteConfDir(this._profileId, "hard")}/tag_${this.o.uid}_vc.conf`;
        await fs.unlinkAsync(tagConfPath).catch((err) => {});
        await fs.unlinkAsync(vcConfPath).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }

      this._profileId = profileId;
      if (!profileId) {
        log.verbose(`Profile id is not set on ${this.o.uid}`);
        return;
      }
      const rule = new Rule("mangle")
          .jmp(`SET --map-set ${profileId.startsWith("VWG:") ? VirtWanGroup.getRouteIpsetName(profileId.substring(4)) : VPNClient.getRouteIpsetName(profileId)} dst,dst --map-mark`)
          .comment(`policy:tag:${this.o.uid}`);

      if (profileId.startsWith("VWG:"))
        await VirtWanGroup.ensureCreateEnforcementEnv(profileId.substring(4));
      else
        await VPNClient.ensureCreateEnforcementEnv(profileId);
      await Tag.ensureCreateEnforcementEnv(this.o.uid); // just in case

      const vcConfPath = profileId.startsWith("VWG:") ? `${VirtWanGroup.getDNSRouteConfDir(profileId.substring(4), "hard")}/tag_${this.o.uid}_vc.conf` : `${VPNClient.getDNSRouteConfDir(profileId, "hard")}/tag_${this.o.uid}_vc.conf`;

      if (state === true) {
        const devRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5");
        const devRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5").fam(6);
        const netRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagNetSetName(this.o.uid)} src,src`).chn("FW_RT_TAG_NETWORK_5");
        const netRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagNetSetName(this.o.uid)} src,src`).chn("FW_RT_TAG_NETWORK_5").fam(6);
        await exec(devRule4.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv4 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await exec(devRule6.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv6 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await exec(netRule4.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv4 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await exec(netRule6.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv6 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });

        // remove rule that was set by state == null
        devRule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        devRule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        netRule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        netRule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(devRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(devRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        const markTag = `${profileId.startsWith("VWG:") ? VirtWanGroup.getDnsMarkTag(profileId.substring(4)) : VPNClient.getDnsMarkTag(profileId)}`;
        // use two config files, one in network directory, the other in vpn client hard route directory, the second file is controlled by conf-dir in VPNClient.js and will not be included when client is disconnected
        await fs.writeFileAsync(tagConfPath, `group-tag=@${this.o.uid}$vc_tag_${this.o.uid}`).catch((err) => {});
        await fs.writeFileAsync(vcConfPath, `tag-tag=$vc_tag_${this.o.uid}$${markTag}$!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // null means off
      if (state === null) {
        // remove rule that was set by state == true
        const devRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5");
        const devRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5").fam(6);
        const netRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagNetSetName(this.o.uid)} src,src`).chn("FW_RT_TAG_NETWORK_5");
        const netRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagNetSetName(this.o.uid)} src,src`).chn("FW_RT_TAG_NETWORK_5").fam(6);
        await exec(devRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(devRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        // override target and clear vpn client bits in fwmark
        devRule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        devRule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        netRule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        netRule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(devRule4.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv4 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await exec(devRule6.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv6 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await exec(netRule4.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv4 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await exec(netRule6.toCmd('-A')).catch((err) => {
          log.error(`Failed to add ipv6 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await fs.writeFileAsync(tagConfPath, `group-tag=@${this.o.uid}$vc_tag_${this.o.uid}`).catch((err) => {});
        await fs.writeFileAsync(vcConfPath, `tag-tag=$vc_tag_${this.o.uid}$${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // false means N/A
      if (state === false) {
        const devRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5");
        const devRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5").fam(6);
        const netRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagNetSetName(this.o.uid)} src,src`).chn("FW_RT_TAG_NETWORK_5");
        const netRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagNetSetName(this.o.uid)} src,src`).chn("FW_RT_TAG_NETWORK_5").fam(6);
        await exec(devRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await exec(devRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await exec(netRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });
        await exec(netRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for tag ${this.o.uid} ${profileId}`, err.message);
        });

        // remove rule that was set by state == null
        devRule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        devRule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        netRule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        netRule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
        await exec(devRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(devRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule4.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv4 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await exec(netRule6.toCmd('-D')).catch((err) => {
          log.error(`Failed to remove ipv6 vpn client rule for ${this.o.uid} ${this._profileId}`, err.message);
        });
        await fs.unlinkAsync(tagConfPath).catch((err) => {});
        await fs.unlinkAsync(vcConfPath).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
    } catch (err) {
      log.error(`Failed to set VPN client access on tag ${this.o.uid} ${this.o.name}`, err.message);
    }
  }

  async tags(tags) {
    // do not support embedded tags
  }
}

module.exports = Tag;
