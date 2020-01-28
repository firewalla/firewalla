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

  static getTagIpsetName(uid) {
    return `c_tag_${uid}_set`;
  }

  static getTagMacIpsetName(uid) {
    return `c_tag_${uid}_m_set`
  }

  async createEnv() {
    // create related ipsets
    await exec(`sudo ipset create -! ${Tag.getTagIpsetName(this.o.uid)} list:set`).catch((err) => {
      log.error(`Failed to create tag ipset ${Tag.getTagIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset create -! ${Tag.getTagMacIpsetName(this.o.uid)} hash:mac`).catch((err) => {
      log.error(`Failed to create tag ipset ${Tag.getTagMacIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset add -! ${Tag.getTagIpsetName(this.o.uid)} ${Tag.getTagMacIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to add ${Tag.getTagMacIpsetName(this.o.uid)} to ipset ${Tag.getTagIpsetName(this.o.uid)}`, err.message);
    });
  }

  async destroyEnv() {
    // flush related ipsets
    await exec(`sudo ipset flush -! ${Tag.getTagIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag ipset ${Tag.getTagIpsetName(this.o.uid)}`, err.message);
    });
    await exec(`sudo ipset flush -! ${Tag.getTagMacIpsetName(this.o.uid)}`).catch((err) => {
      log.error(`Failed to flush tag ipset ${Tag.getTagMacIpsetName(this.o.uid)}`, err.message);
    });
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

  }

  async tags(tags) {
    // do not support embedded tags
  }
}

module.exports = Tag;