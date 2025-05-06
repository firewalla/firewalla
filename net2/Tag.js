/*    Copyright 2020-2024 Firewalla Inc.
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
const sysManager = require('./SysManager.js');
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
const _ = require('lodash');
Promise.promisifyAll(fs);
const scheduler = require('../util/scheduler.js');
const HostTool = require('./HostTool.js');
const hostTool = new HostTool();
const fwapc = require('./fwapc.js');
const {delay} = require('../util/util.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();

const envCreatedMap = {};


class Tag extends Monitorable {
  static metaFieldsNumber = ["createTs"];

  constructor(o) {
    if (!Monitorable.instances[o.uid]) {
      super(o)
      Monitorable.instances[o.uid] = this

      if (f.isMain()) (async () => {
        await sysManager.waitTillIptablesReady()
        await this.createEnv();
        await this.applyPolicy();
      })().catch(err => {
        log.error(`Error initializing Host ${this.o.mac}`, err);
      })

      log.info(`Created new ${this.getTagType()} Tag: ${this.getUniqueId()}`)
      if (f.isMain()) {
        this.fwapcSetGroupMACsJob = new scheduler.UpdateJob(this.fwapcSetGroupMACs.bind(this), 5000);
      }
    }
    return Monitorable.instances[o.uid]
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

  getTagType() {
    return this.o.type || Constants.TAG_TYPE_GROUP;
  }

  getReadableName() {
    return this.o.name || super.getReadableName()
  }

  getTagUid() {
    return this.o.uid;
  }

  getMetaKey() {
    return Constants.TAG_TYPE_MAP[this.getTagType()].redisKeyPrefix + this.getUniqueId()
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

  // this can be used to add to list:set of another tag, i.e. a tag can belong to another tag
  static getTagDeviceIPSetName(uid, af = 4) {
    return `c_tag_${uid}_dev_ip${af}_set`
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
    log.verbose(`Creating env for Tag: ${uid}`)
    // create related ipsets
    await exec(`sudo ipset create -! ${Tag.getTagSetName(uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag ipset ${Tag.getTagSetName(uid)}`, err.message);
    });
    await exec(`sudo ipset create -! ${Tag.getTagDeviceMacSetName(uid)} hash:mac`).catch((err) => {
      log.error(`Failed to create tag mac ipset ${Tag.getTagDeviceMacSetName(uid)}`, err.message);
    });
    await exec(`sudo ipset create -! ${Tag.getTagDeviceIPSetName(uid, 4)} hash:net family inet timeout 900`).catch((err) => {
      log.error(`Failed to create tag IP ipset ${Tag.getTagDeviceIPSetName(uid, 4)}`, err.message);
    });
    await exec(`sudo ipset create -! ${Tag.getTagDeviceIPSetName(uid, 6)} hash:net family inet6 timeout 900`).catch((err) => {
      log.error(`Failed to create tag IP ipset ${Tag.getTagDeviceIPSetName(uid, 6)}`, err.message);
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
    await exec(`sudo ipset flush -! ${Tag.getTagDeviceIPSetName(this.o.uid, 4)}`).catch((err) => {
      log.error(`Failed to flush tag mac ipset ${Tag.getTagDeviceIPSetName(this.o.uid, 4)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagDeviceIPSetName(this.o.uid, 6)}`).catch((err) => {
      log.error(`Failed to flush tag mac ipset ${Tag.getTagDeviceIPSetName(this.o.uid, 6)}`, err.message);
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
    await this.fwapcDeleteGroup().catch((err) => {});
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

  async tags(tags, type = Constants.TAG_TYPE_GROUP) {
    // a tag can belong to another tag, in real practice, a group can belong to a user
    const policyKey = _.get(Constants.TAG_TYPE_MAP, [type, "policyKey"]);
    if (!policyKey) {
      log.error(`Unknown tag type ${type}, ignore tags`, tags);
      return;
    }
    const TagManager = require('./TagManager.js');
    tags = (tags || []).map(String);
    this[`_${policyKey}`] = this[`_${policyKey}`] || [];
    // remove old tags that are not in updated tags
    const removedTags = this[`_${policyKey}`].filter(uid => !tags.includes(uid));
    for (let removedTag of removedTags) {
      const tagExists = await TagManager.tagUidExists(removedTag, type);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(removedTag);
        await exec(`sudo ipset del -! ${Tag.getTagDeviceSetName(removedTag)} ${Tag.getTagDeviceMacSetName(this.o.uid)}`).catch((err) => {});
        await exec(`sudo ipset del -! ${Tag.getTagDeviceSetName(removedTag)} ${Tag.getTagDeviceIPSetName(this.o.uid, 4)}`).catch((err) => {});
        await exec(`sudo ipset del -! ${Tag.getTagDeviceSetName(removedTag)} ${Tag.getTagDeviceIPSetName(this.o.uid, 6)}`).catch((err) => {});
        await exec(`sudo ipset del -! ${Tag.getTagSetName(removedTag)} ${Tag.getTagDeviceMacSetName(this.o.uid)}`).catch((err) => {});
        await exec(`sudo ipset del -! ${Tag.getTagSetName(removedTag)} ${Tag.getTagDeviceIPSetName(this.o.uid, 4)}`).catch((err) => {});
        await exec(`sudo ipset del -! ${Tag.getTagSetName(removedTag)} ${Tag.getTagDeviceIPSetName(this.o.uid, 6)}`).catch((err) => {});
      }
    }
    await fs.unlinkAsync(`${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}.conf`).catch((err) => {});
    // filter updated tags in case some tag is already deleted from system
    const updatedTags = [];
    for (let uid of tags) {
      const tagExists = await TagManager.tagUidExists(uid, type);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(uid);
        await exec(`sudo ipset add -! ${Tag.getTagDeviceSetName(uid)} ${Tag.getTagDeviceMacSetName(this.o.uid)}`).catch((err) => {});
        await exec(`sudo ipset add -! ${Tag.getTagDeviceSetName(uid)} ${Tag.getTagDeviceIPSetName(this.o.uid, 4)}`).catch((err) => {});
        await exec(`sudo ipset add -! ${Tag.getTagDeviceSetName(uid)} ${Tag.getTagDeviceIPSetName(this.o.uid, 6)}`).catch((err) => {});
        await exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${Tag.getTagDeviceMacSetName(this.o.uid)}`).catch((err) => {});
        await exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${Tag.getTagDeviceIPSetName(this.o.uid, 4)}`).catch((err) => {});
        await exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${Tag.getTagDeviceIPSetName(this.o.uid, 6)}`).catch((err) => {});
        updatedTags.push(uid);
      }
    }
    if (!_.isEmpty(updatedTags))
      await fs.writeFileAsync(`${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}.conf`, `group-group=@${this.o.uid}${updatedTags.map(t => `@${t}`)}`, {encoding: "utf8"});
    dnsmasq.scheduleRestartDNSService();
    this[`_${policyKey}`] = updatedTags;
    await this.setPolicyAsync(policyKey, this[`_${policyKey}`]); // keep tags in policy data up-to-date
  }

  static async scheduleFwapcSetGroupMACs(uid, type) {
    const TagManager = require('./TagManager.js');
    // in case tag is stored in redis but not synced into firemain, wait for it to become available in TagManager
    let retryCount = 5;
    while (await TagManager.tagUidExists(uid, type) && retryCount-- > 0) {
      const tag = await TagManager.getTagByUid(uid);
      if (tag) {
        tag.fwapcSetGroupMACsJob.exec().catch((err) => {});
        break;
      }
      await delay(3000);
    }
  }

  async fwapcSetGroupMACs() {
    if (!platform.isFireRouterManaged())
      return;
    const HostManager = require('./HostManager.js');
    const hostManager = new HostManager();
    const macs = await hostManager.getTagMacs(this.o.uid).then(results => results.filter(m => hostTool.isMacAddress(m))).catch((err) => {
      log.error(`Failed to get MAC addresses in group ${this.o.uid}`, err.message);
      return null;
    });
    if (macs) {
      await fwapc.setGroup(this.o.uid, { macs }).catch((err) => {
        log.error(`Failed to set group ACL in fwapc for ${this.getTagType()} ${this.o.uid}`, err.message);
      });
    }
  }

  async fwapcDeleteGroup() {
    if (!platform.isFireRouterManaged())
      return;
    await fwapc.deleteGroup(this.o.uid).catch((err) => {
      log.error(`Failed to delete group ACL in fwapc for ${this.getTagType()} ${this.o.uid}`, err.message);
    });
  }
}

module.exports = Tag;
