/*    Copyright 2019 Firewalla Inc
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

const f = require('./Firewalla.js');
const iptables = require('./Iptables.js');

class NetworkProfile {
  constructor(o) {
    this.o = o;
    this._policy = {};
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    if (f.isMain()) {
      if (o && o.uuid) {
        this.subscriber.subscribeOnce("DiscoveryEvent", "NetworkPolicy:Changed", this.o.uuid, (channel, type, id, obj) => {
          log.info(`Network policy is changed on ${this.o.intf}, uuid: ${this.o.uuid}`, obj);
          this.applyPolicy();
        })
      }
    }
    return this;
  }

  update(o) {
    this.o = o;
  }

  toJson() {
    return this.o;
  }

  setActive(active) {
    this.o.active = active;
  }

  async setPolicy(name, data) {
    this._policy[name] = data;
    await this.savePolicy();
    if (this.subscriber) {
      setTimeout(() => {
        this.subscriber.publish("DiscoveryEvent", "NetworkPolicy:Changed", this.o.uuid, data);
      }, 2000); // 2 seconds buffer for concurrent policy data change to be persisted
    }
  }

  async applyPolicy() {
    await this.loadPolicy();
    const policy = JSON.parse(JSON.stringify(this._policy));
    const PolicyManager = require('./PolicyManager.js');
    const pm = new PolicyManager();
    await pm.executeAsync(this, this.o.uuid, policy);
  }

  _getPolicyKey() {
    return `policy:network:${this.o.uuid}`;
  }

  async savePolicy() {
    const key = this._getPolicyKey();
    const policyObj = {};
    for (let k in this._policy) {
      policyObj[k] = JSON.stringify(this._policy[k]);
    }
    await rclient.hmsetAsync(key, policyObj).catch((err) => {
      log.error(`Failed to save policy to ${key}`, err);
    });
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

  // This actually incidates monitoring state. Old glossary used in PolicyManager.js
  async spoof(state) {
    if (state === true) {
      await iptables.switchInterfaceMonitoringAsync(true);
    } else {
      await iptables.switchInterfaceMonitoringAsync(false);
    }
  }

  async vpnClient(policy) {

  }

  async whitelist(state) {

  }

  async shield(policy) {

  }

  // underscore prefix? follow same function name in Host.js :(
  async _dnsmasq(policy) {

  }
}

module.exports = NetworkProfile;