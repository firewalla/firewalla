/*    Copyright 2020 Firewalla Inc
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
const PolicyManager = require('./PolicyManager.js');
const pm = new PolicyManager();
const f = require('./Firewalla.js');
const exec = require('child-process-promise').exec;
const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');
const wrapIptables = require('./Iptables').wrapIptables;

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
          this.applyPolicy();
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
      setTimeout(() => {
        this.subscriber.publish("DiscoveryEvent", "TagPolicy:Changed", this.o.uid, {name, data});
      }, 2000); // 2 seconds buffer for concurrent policy dta change to be persisted
    }
  }

  // this can be used to match everything on this tag, including device and network
  static getTagIpsetName(uid) {
    return `c_tag_${uid}_set`;
  }

  // this can be used to match device alone on this tag
  static getTagMacIpsetName(uid) {
    return `c_tag_${uid}_m_set`
  }

  // this can be used to match network alone on this tag
  static getTagNetIpsetName(uid) {
    return `c_tag_${uid}_n_set`;
  }

  async createEnv() {
    // create related ipsets
    await exec(`sudo ipset create -! ${Tag.getTagIpsetName(this.o.uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag ipset ${Tag.getTagIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset create -! ${Tag.getTagMacIpsetName(this.o.uid)} hash:mac`).catch((err) => {
      log.error(`Failed to create tag mac ipset ${Tag.getTagMacIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset add -! ${Tag.getTagIpsetName(this.o.uid)} ${Tag.getTagMacIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to add ${Tag.getTagMacIpsetName(this.o.uid)} to ipset ${Tag.getTagIpsetName(this.o.uid)}`, err.message);
    });
    // you may think this tag net set is redundant? 
    // it is needed to apply fine-grained policy on tag level. e.g., customized wan, QoS
    await exec(`sudo ipset create -! ${Tag.getTagNetIpsetName(this.o.uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag net ipset ${Tag.getTagNetIpsetName(this.o.uid)}`, err.message);
    });
  }

  async destroyEnv() {
    // flush related ipsets
    await exec(`sudo ipset flush -! ${Tag.getTagIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag ipset ${Tag.getTagIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagMacIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag mac ipset ${Tag.getTagMacIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagNetIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag net ipset ${Tag.getTagNetIpsetName(this.o.uid)}`, err.message);
    })
    // delete related dnsmasq config files
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}_*`).catch((err) => {}); // delete files in global effective directory
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/*/tag_${this.o.uid}_*`).catch((err) => {}); // delete files in network-wise effective directories
  }

  async spoof(state) {
    // do nothing for spoof on tag
  }

  async _dnsmasq(config) {
    // do nothing for dnsmasq on tag
  }

  async vpnClient(policy) {
    try {
      const state = policy.state;
      const profileId = policy.profileId;
      if (!profileId) {
        log.warn(`VPN client profileId is not specified for ${this.o.uid} ${this.o.name}`);
        return false;
      }
      const ovpnClient = new OpenVPNClient({profileId: profileId});
      const intf = ovpnClient.getInterfaceName();
      const rtId = await vpnClientEnforcer.getRtId(intf);
      if (!rtId)
        return false;
      const rtIdHex = Number(rtId).toString(16);
      // remove old mark first
      await exec(`sudo ipset -! del c_wan_tag_m_set ${Tag.getTagMacIpsetName(this.o.uid)}`);
      if (this._netFwMark) {
        let cmd = wrapIptables(`sudo iptables -t mangle -D FW_PREROUTING_WAN_TAG_N -m set --match-set ${Tag.getTagNetIpsetName(this.o.uid)} src,src -j MARK --set-mark 0x${this._netFwMark}/0xffff`);
        await exec(cmd).catch((err) => {});
        cmd = wrapIptables(`sudo ip6tables -t mangle -D FW_PREROUTING_WAN_TAG_N -m set --match-set ${Tag.getTagNetIpsetName(this.o.uid)} src,src -j MARK --set-mark 0x${this._netFwMark}/0xffff`);
        await exec(cmd).catch((err) => {});
      }
      this._netFwMark = null;
      if (state === true) {
        // set skbmark
        this._netFwMark = rtIdHex;
      }
      if (state === false) {
        // reset skbmark
        this._netFwMark = "0000";
      }
      if (state === null) {
        // do not change skbmark
      }
      if (this._netFwMark) {
        await exec(`sudo ipset -! add c_wan_tag_m_set ${Tag.getTagMacIpsetName(this.o.uid)} skbmark 0x${this._netFwMark}/0xffff`);
        let cmd = wrapIptables(`sudo iptables -t mangle -A FW_PREROUTING_WAN_TAG_N -m set --match-set ${Tag.getTagNetIpsetName(this.o.uid)} src,src -j MARK --set-mark 0x${this._netFwMark}/0xffff`);
        await exec(cmd).catch((err) => {});
        cmd = wrapIptables(`sudo ip6tables -t mangle -A FW_PREROUTING_WAN_TAG_N -m set --match-set ${Tag.getTagNetIpsetName(this.o.uid)} src,src -j MARK --set-mark 0x${this._netFwMark}/0xffff`);
        await exec(cmd).catch((err) => {});
      }
      return true;
    } catch (err) {
      log.error(`Failed to set VPN client access on tag ${this.o.uid} ${this.o.name}`, err.message);
      return false;
    }
  }

  async tags(tags) {
    // do not support embedded tags
  }
}

module.exports = Tag;