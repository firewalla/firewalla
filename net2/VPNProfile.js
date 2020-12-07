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

const fs = require('fs');
const Promise = require('bluebird');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const ipset = require('./Ipset.js');
const _ = require('lodash');
Promise.promisifyAll(fs);

const envCreatedMap = {};

class VPNProfile {
  constructor(o) {
    this.o = o;
    this._policy = {};
    const c = require('./MessageBus.js');
    this.subscriber = new c('info');
    if (f.isMain()) {
      if (o && o.cn) {
        this.subscriber.subscribeOnce("DiscoveryEvent", "VPNProfilePolicy:Changed", this.o.cn, (channel, type, id, obj) => {
          log.info(`VPN profile policy is changed on ${this.o.cn}`, obj);
          this.scheduleApplyPolicy();
        })
      }
    }
  }

  update(o) {
    this.o = o;
  }

  _getPolicyKey() {
    return `policy:vpn_profile:${this.o.cn}`;
  }

  toJson() {
    const json = Object.assign({}, this.o, {policy: this._policy});
    return json;
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
    await pm.executeAsync(this, this.o.cn, policy);
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
      this.subscriber.publish("DiscoveryEvent", "VPNProfilePolicy:Changed", this.o.cn, {name, data});
    }
  }

  static getVPNProfileSetName(cn) {
    return `c_vpn_prof_${cn.substring(0, 12)}_set`;
  }

  static async ensureCreateEnforcementEnv(cn) {
    if (envCreatedMap[cn])
      return;
    // create related ipsets
    await exec(`sudo ipset create -! ${VPNProfile.getVPNProfileSetName(cn)} hash:net`).catch((err) => {
      log.error(`Failed to create VPN profile ipset ${VPNProfile.getVPNProfileSetName(cn)}`, err.message);
    });
    envCreatedMap[cn] = 1;
  }

  async createEnv() {
    await VPNProfile.ensureCreateEnforcementEnv(this.o.cn);
  }

  async destoryEnv() {
    await exec(`sudo ipset flush -! ${VPNProfile.getVPNProfileSetName(this.o.cn)}`).catch((err) => {
      log.error(`Failed to flush VPN profile ipset ${VPNProfile.getVPNProfileSetName(this.o.cn)}`, err.message);
    });
  }

  async updateClientIPs(clientIPs) {
    if (this._clientIPs && _.isEqual(clientIPs.sort(), this._clientIPs.sort())) {
      log.info(`Client IP addresses of ${this.o.cn} is not changed`, clientIPs);
      return;
    }
    log.info(`Client IP addresses of ${this.o.cn} is changed`, this._clientIPs, clientIPs);
    await exec(`sudo ipset flush ${VPNProfile.getVPNProfileSetName(this.o.cn)}`).catch((err) => {
      log.error(`Failed to flush ${VPNProfile.getVPNProfileSetName(this.o.cn)}`, err.message);
    });
    const cmds = clientIPs.map(ip => `add ${VPNProfile.getVPNProfileSetName(this.o.cn)} ${ip}`);
    await ipset.batchOp(cmds).catch((err) => {
      log.error(`Failed to populate client ipset of ${this.o.cn}`, err.message);
    });
    // TODO: update dnsmasq config file

    this._clientIPs = clientIPs;
  }

  async spoof(state) {

  }
}

module.exports = VPNProfile;