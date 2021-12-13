/*    Copyright 2021 Firewalla Inc.
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
const MessageBus = require('./MessageBus.js');

// TODO: extract common methods like vpnClient() _dnsmasq() from Host, Identity, NetworkProfile, Tag
class Monitorable {
  constructor(o) {
    this.o = o
    this.policy = {};
    this.subscriber = new MessageBus('info')
  }

  update(o) {
    this.o = o;
  }

  toJson() {
    const json = Object.assign({}, this.o, {policy: this.policy});
    return json;
  }

  getUniqueId() { }

  getGUID() {}

  _getPolicyKey() { }

  async savePolicy() {
    const key = this._getPolicyKey();
    const policyObj = {};
    for (let k in this.policy) {
      policyObj[k] = JSON.stringify(this.policy[k]);
    }
    await rclient.hmsetAsync(key, policyObj).catch((err) => {
      log.error(`Failed to save policy to ${key}`, err);
    })
  }

  async loadPolicy() {
    const key = this._getPolicyKey();
    const policyData = await rclient.hgetallAsync(key);
    if (policyData) {
      for (let k in policyData) {
        policyData[k] = JSON.parse(policyData[k]);
      }
    }
    this.policy = policyData || {}
    return this.policy;
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
    const policy = JSON.parse(JSON.stringify(this.policy));
    await pm.executeAsync(this, this.getUniqueId(), policy);
  }

  // policy.profile:
  // nothing needs to be done here.
  // policy gets reloaded each time FlowMonitor.run() is called
}

module.exports = Monitorable;
