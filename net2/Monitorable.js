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

const _ = require('lodash')

// TODO: extract common methods like vpnClient() _dnsmasq() from Host, Identity, NetworkProfile, Tag
class Monitorable {

  static metaFieldsJson = []

  // TODO: mitigate confusion between this.x and this.o.x across devided classes
  static parse(obj) {
    for (const key in obj) {
      if (this.metaFieldsJson.includes(key) && _.isString(obj[key])) {
        try {
          while (_.isString(obj[key])) {
            const o = JSON.parse(obj[key]);
            if (o == obj[key])
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

  getGUID() { throw new Error('Not Implemented') }

  getMetaKey() { throw new Error('Not Implemented') }

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
