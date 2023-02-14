/*    Copyright 2021-2022 Firewalla Inc.
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

const util = require('util')
const _ = require('lodash')

// TODO: extract common methods like vpnClient() _dnsmasq() from Host, Identity, NetworkProfile, Tag
class Monitorable {

  static metaFieldsJson = []

  // TODO: mitigate confusion between this.x and this.o.x across devided classes
  static parse(obj) {
    for (const key in obj) {
      if (this.metaFieldsJson.includes(key)) {
        try {
          // sometimes a field got encoded multiple times, this is a safe guard for that situation
          while (_.isString(obj[key])) {
            const o = JSON.parse(obj[key]);
            if (o === obj[key])
              break;
            obj[key] = o;
          }
        } catch (err) {
          log.error('Parsing', key, obj[key])
        }
      }
    }
    return obj
  }


  constructor(o) {
    this.o = o
    this.policy = {};
    this.subscriber = new MessageBus('info')
  }

  async update(o) {
    this.o = o;
  }

  toJson() {
    const json = Object.assign({}, this.o, {policy: this.policy});
    return json;
  }

  getUniqueId() { throw new Error('Not Implemented') }

  getGUID() { return this.getUniqueId() }

  getMetaKey() { throw new Error('Not Implemented') }

  getClassName() { return this.constructor.name }

  getReadableName() {
    return this.getGUID()
  }

  redisfy() {
    const obj = Object.assign({}, this.o)
    for (const f in obj) {
      // some fields in this.o may be set as string and converted to object/array later in constructor() or update(), need to double-check in case this function is called after the field is set and before it is converted to object/array
      if (this.constructor.metaFieldsJson.includes(f) && !_.isString(this.o[f]) || obj[f] === null || obj[f] === undefined)
        obj[f] = JSON.stringify(this.o[f])
    }
    return obj
  }

  async save(fields) {
    let obj = this.redisfy();

    if (fields) {
      // it works if fields represents a single key as string
      obj = _.pick(obj, fields)
    }

    log.debug('Saving', this.getMetaKey(), fields, obj)
    if (Object.keys(obj).length)
      await rclient.hmsetAsync(this.getMetaKey(), obj)
  }

  _getPolicyKey() { throw new Error('Not Implemented') }

  async saveSinglePolicy(name, policy) {
    this.policy[name] = policy
    const key = this._getPolicyKey()
    await rclient.hmsetAsync(key, name, JSON.stringify(policy))
  }

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

  setPolicy(name, data, callback = ()=>{}) {
    return util.callbackify(this.setPolicyAsync).bind(this)(name, data, callback)
  }

  async setPolicyAsync(name, data) {
    // policy should be in sync once object is initialized
    if (!this.policy) await this.loadPolicyAsync();

    if (this.policy[name] != null && JSON.stringify(this.policy[name]) == JSON.stringify(data)) {
      log.debug(`${this.getClassName()}:setPolicy:Nochange`, this.getGUID(), name, data);
      return;
    }
    await this.saveSinglePolicy(name, data)

    const obj = {};
    obj[name] = data;
    if (this.subscriber) {
      this.subscriber.publish("DiscoveryEvent", `${this.getClassName()}Policy:Changed`, this.getUniqueId(), obj);
    }
    return obj
  }

  async loadPolicyAsync() {
    const key = this._getPolicyKey();
    const policyData = await rclient.hgetallAsync(key);
    if (policyData) {
      for (let k in policyData) try {
        policyData[k] = JSON.parse(policyData[k]);
      } catch (err) {
        log.error(`Failed to parse policy ${this.getGUID()} ${k} with value "${policyData[k]}"`, err)
      }
    }
    this.policy = policyData || {}
    return this.policy;
  }

  loadPolicy(callback) {
    return util.callbackify(this.loadPolicyAsync).bind(this)(callback || function(){})
  }

  scheduleApplyPolicy() {
    if (this.applyPolicyTask)
      clearTimeout(this.applyPolicyTask);
    this.applyPolicyTask = setTimeout(() => {
      this.applyPolicy();
    }, 3000);
  }

  async applyPolicy() {
    await this.loadPolicyAsync();
    const policy = JSON.parse(JSON.stringify(this.policy));
    await pm.executeAsync(this, this.getUniqueId(), policy);
  }

  // policy.profile:
  // nothing needs to be done here.
  // policy gets reloaded each time FlowMonitor.run() is called

  async aclTimer(policy = {}) {
    if (this._aclTimer)
      clearTimeout(this._aclTimer);
    if (policy.hasOwnProperty("state") && !isNaN(policy.time) && policy.time) {
      const nextState = policy.state;
      if (Number(policy.time) > Date.now() / 1000) {
        this._aclTimer = setTimeout(() => {
          log.info(`Set acl on ${this.getUniqueId()} to ${nextState} in acl timer`);
          this.setPolicy("acl", nextState);
          this.setPolicy("aclTimer", {});
        }, policy.time * 1000 - Date.now());
      } else {
        // old timer is already expired when the function is invoked, maybe caused by system reboot
        if (!this.policy || !this.policy.acl || this.policy.acl != nextState) {
          log.info(`Set acl on ${this.getUniqueId()} to ${nextState} immediately in acl timer`);
          this.setPolicy("acl", nextState);
        }
        this.setPolicy("aclTimer", {});
      }
    }
  }

  async qosTimer(policy = {}) {
    if (this._qosTimer)
      clearTimeout(this._qosTimer);
    if (policy.hasOwnProperty("state") && !isNaN(policy.state) && policy.time) {
      const nextState = policy.state;
      if (Number(policy.time) > Date.now() / 1000) {
        this._qosTimer = setTimeout(() => {
          const newPolicy = Object.assign({}, this.policy && this.policy.qos, {state: nextState});
          log.info(`Set qos on ${this.getUniqueId()} to ${nextState} in qos timer`);
          this.setPolicy("qos", newPolicy);
          this.setPolicy("qosTimer", {});
        }, policy.time * 1000 - Date.now());
      } else {
        // old timer is already expired when the function is invoked, maybe caused by system reboot
        if (!this.policy || !this.policy.qos || this.policy.qos.state != nextState) {
          log.info(`Set qos on ${this.getUniqueId()} to ${nextState} immediately in qos timer`);
          const newPolicy = Object.assign({}, this.policy && this.policy.qos, {state: nextState});
          this.setPolicy("qos", newPolicy);
        }
        this.setPolicy("qosTimer", {});
      }
    }
  }
}

module.exports = Monitorable;
