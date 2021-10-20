/*    Copyright 2020-2021 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient();
const pm = require('./PolicyManager.js');
const f = require('./Firewalla.js');
const exec = require('child-process-promise').exec;
const VPNClient = require('../extension/vpnclient/VPNClient.js');
const {Rule, wrapIptables} = require('./Iptables.js');
const fs = require('fs');
const Promise = require('bluebird');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const routing = require('../extension/routing/routing.js');
const dnsmasq = new DNSMASQ();
Promise.promisifyAll(fs);

const envCreatedMap = {};


class Tag {
  constructor(o) {
    this.o = o;
    this._policy = {};
    const c = require('./MessageBus.js');
    this.subscriber = new c('info');
    if (f.isMain()) {
      if (o && o.uid) {
        this.subscriber.subscribeOnce("DiscoveryEvent", "TagPolicy:Changed", this.o.uid, (channel, type, id, obj) => {
          log.info(`Tag policy is changed on ${this.o.uid} ${this.o.name}`, obj);
          this.scheduleApplyPolicy();
        });
      }
    }
    return this;
  }

  update(o) {
    this.o = o;
  }

  toJson() {
    const json = Object.assign({}, this.o, {policy: this._policy});
    return json;
  }

  setTagName(name) {
    this.o.name = name;
  }

  getTagName() {
    return this.o.name;
  }

  getTagUid() {
    return this.o.uid;
  }

  _getPolicyKey() {
    return `policy:tag:${this.o.uid}`;
  }

  scheduleApplyPolicy() {
    if (this.applyPolicyTask)
      clearTimeout(this.applyPolicyTask);
    this.applyPolicyTask = setTimeout(() => {
      this.applyPolicy();
    }, 3000);
  }

  async applyPolicy() {
    await this.loadPolicy();
    const policy = JSON.parse(JSON.stringify(this._policy));
    await pm.executeAsync(this, this.o.uid, policy);
  }

  async loadPolicy() {
    const key = this._getPolicyKey();
    const policyData = await rclient.hgetallAsync(key);
    if (policyData) {
      this._policy = {};
      for (let k in policyData) {
        this._policy[k] = JSON.parse(policyData[k]);
      }
    } else {
      this._policy = {};
    }
    return this._policy;
  }

  async savePolicy() {
    const key = this._getPolicyKey();
    const policyObj = {};
    for (let k in this._policy) {
      policyObj[k] = JSON.stringify(this._policy[k]);
    }
    await rclient.hmsetAsync(key, policyObj).catch((err) => {
      log.error(`Failed to save policy to ${key}`, err);
    })
  }

  async setPolicy(name, data) {
    this._policy[name] = data;
    await this.savePolicy();
    if (this.subscriber) {
      this.subscriber.publish("DiscoveryEvent", "TagPolicy:Changed", this.o.uid, {name, data});
    }
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
    const FlowManager = require('../net2/FlowManager.js');
    const flowManager = new FlowManager('info');

    await flowAggrTool.removeAggrFlowsAllTag(this.o.uid);
    await flowManager.removeFlowTag(this.o.uid);

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

  async qos(state) {
    // do nothing for qos on tag
  }

  async acl(state) {
    // do nothing for acl on tag
  }

  async aclTimer(policy = {}) {
    if (this._aclTimer)
      clearTimeout(this._aclTimer);
    if (policy.hasOwnProperty("state") && !isNaN(policy.time) && Number(policy.time) > Date.now() / 1000) {
      const nextState = policy.state;
      this._aclTimer = setTimeout(() => {
        log.info(`Set acl on ${this.o.uid} to ${nextState} in acl timer`);
        this.setPolicy("acl", nextState);
      }, policy.time * 1000 - Date.now());
    }
  }

  async spoof(state) {
    // do nothing for spoof on tag
  }

  async _dnsmasq(config) {
    // do nothing for dnsmasq on tag
  }

  async shield(policy) {
  }

  async getVpnClientProfileId() {
    if (!this._policy)
      await this.loadPolicy();
    if (this._policy.vpnClient) {
      if (this._policy.vpnClient.state === true && this._policy.vpnClient.profileId)
        return this._policy.vpnClient.profileId;
    }
    return null;
  }

  async vpnClient(policy) {
    try {
      const state = policy.state;
      const profileId = policy.profileId;
      if (this._profileId && profileId !== this._profileId) {
        log.info(`Current VPN profile id is different from the previous profile id ${this._profileId}, remove old rule on tag ${this.o.uid}`);
        const rule = new Rule("mangle")
          .jmp(`SET --map-set ${VPNClient.getRouteIpsetName(this._profileId)} dst,dst --map-mark`)
          .comment(`policy:tag:${this.o.uid}`);
        const devRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceMacSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5");
        const devRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceMacSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5").fam(6);
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
      }

      this._profileId = profileId;
      if (!profileId) {
        log.warn(`Profile id is not set on ${this.o.uid}`);
        return;
      }
      const rule = new Rule("mangle")
          .jmp(`SET --map-set ${VPNClient.getRouteIpsetName(profileId)} dst,dst --map-mark`)
          .comment(`policy:tag:${this.o.uid}`);

      await VPNClient.ensureCreateEnforcementEnv(profileId);
      await Tag.ensureCreateEnforcementEnv(this.o.uid); // just in case

      if (state === true) {
        const devRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceMacSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5");
        const devRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceMacSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5").fam(6);
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
      }
      // null means off
      if (state === null) {
        // remove rule that was set by state == true
        const devRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceMacSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5");
        const devRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceMacSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5").fam(6);
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
      }
      // false means N/A
      if (state === false) {
        const devRule4 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceMacSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5");
        const devRule6 = rule.clone().mdl("set", `--match-set ${Tag.getTagDeviceMacSetName(this.o.uid)} src`).chn("FW_RT_TAG_DEVICE_5").fam(6);
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
