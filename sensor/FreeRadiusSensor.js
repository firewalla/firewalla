/*    Copyright 2016-2023 Firewalla Inc.
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

const _ = require('lodash');
let freeradius = require("../extension/freeradius/freeradius.js");
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const f = require('../net2/Firewalla.js');
const log = require('../net2/logger.js')(__filename);
const tagManager = require('../net2/TagManager.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const rclient = require('../util/redis_manager.js').getRedisClient();
const util = require('../util/util.js');
const Sensor = require('./Sensor.js').Sensor;
const sem = require('./SensorEventManager.js').getInstance();

const extensionManager = require('./ExtensionManager.js');
const featureName = 'freeradius_server';
const policyKeyName = 'freeradius_server';
const LOCK_APPLY_FREERADIUS_SERVER_POLICY = "LOCK_APPLY_FREERADIUS_SERVER_POLICY";

class FreeRadiusSensor extends Sensor {
  constructor(config) {
    super(config);

    if (f.isMain()) {
      sem.on("StartFreeRadiusServer", async(event) => {
        if (!this.featureOn) return;
        const policy = await this.loadPolicyAsync();
        return freeradius.startServer(policy.radius, policy.options);
      });

      sem.on("StopFreeRadiusServer", async(event) => {
        if (!this.featureOn) return;
        const policy = await this.loadPolicyAsync();
        await freeradius.stopServer(policy.options);
      });
    }
  }

  async apiRun() {
    extensionManager.onCmd("startFreeRadius", async (msg, data) => {
      sem.sendEventToFireMain({
        type: "StartFreeRadiusServer",
      });
    });

    extensionManager.onCmd("stopFreeRadius", async (msg, data) => {
      sem.sendEventToFireMain({
        type: "StopFreeRadiusServer",
      });
    });

    extensionManager.onGet("getFreeRadiusPass", async (msg, data) => {
      if (!data.username) return {"err": "username must be specified"};
      const pass = await freeradius.getPass(data.username);
      if (!pass) return {"err": "username not found"};
      return {"passwd": pass, "username": data.username};
    });

    sem.on("_refreshFreeRadius", async(event) => {
      await freeradius._loadPasswd();
    });

  }

  async run() {
    this.featureOn = false;
    this._policy = null
    this.policy = null;

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy
    })
    this.hookFeature(featureName);
  }

  async loadPolicyAsync() {
    const data = await rclient.hgetAsync(hostManager._getPolicyKey(), policyKeyName);
    if (!data) {
      return;
    }
    try{
      return JSON.parse(data);
    } catch(err){
      log.warn(`fail to load policy, invalid json ${data}`);
    };
  }

  // global on/off
  async globalOn() {
    this.featureOn = true;
    this._policy = await this.loadPolicyAsync();
    freeradius.prepare(); // prepare in background
  }

  async globalOff() {
    this.featureOn = false;
    if (await freeradius.isListening()) {
      freeradius.stopServer();  // stop container in background
    }
  }

  // apply global policy changes, policy={radius:{}, options:{}}
  async _apply(policy, userpass=null){
    if (!policy) {
      return {err: 'policy must be specified'};
    }
    const _policy = JSON.stringify(policy);
    if (userpass) {
      if (!policy.radius) policy.radius = {};
      if (!policy.radius.users) policy.radius.users = [];
      policy.radius.users.push(...userpass);
    }
    const _aggPolicy = JSON.stringify(policy);

    // compare to previous policy applied
    const diff = util.difference(this.policy, policy);
    if ((!diff || diff.length == 0) && await freeradius.isListening()) {
      log.info(`policy ${policyKeyName} is not changed.`);
      return;
    }
    const {radius, options} = policy;
    // 1. apply to radius-server
    await freeradius.reconfigServer(radius, options);

    // 2. if radius-server fails, reset to previous policy
    if (!await freeradius.isListening() && this._policy) {
        log.error("cannot apply freeradius policy, try to recover previous config");
        await freeradius.reconfigServer(this._policy.radius, this._policy.options);
        return {err: 'failed to reconfigure freeradius server.'};
    }

    // 3. save current policy
    this.policy = JSON.parse(_aggPolicy);
    this._policy = JSON.parse(_policy);
  }

  // policy: {options:{},radius:{clients:[{"name":"","ipaddr":"","require_msg_auth":"yes|no|auto"}], users:[{username:""}]}}
  async applyPolicy(host, ip, policy) {
    if (!this.featureOn) return;
    if (!policy) return;
    log.debug("start to apply policy freeradius", host.constructor.name, ip, policy);
    await this._applyPolicy(policy, ip);
    // refresh freeradius state
    sem.sendEventToFireApi({
      type: "_refreshFreeRadius",
    });
  }

  // policy: {radius:{users:[{username:""}]}}
  async _getTagUserPass() {
    const userpass = []
    const tags = await tagManager.getPolicyTags(policyKeyName);
    for (const tag of tags) {
      const p = await tag.getPolicyAsync(policyKeyName);
      if (p.radius && p.radius.users && _.isArray(p.radius.users)) {
        userpass.push(...p.radius.users);
      }
    }
    return _.uniqWith(userpass, _.isEqual);
  }

  async _applyPolicy(policy, target="0.0.0.0"){
    await lock.acquire(LOCK_APPLY_FREERADIUS_SERVER_POLICY, async() => {
      if (!this.featureOn) {
        log.error(`feature ${featureName} is disabled`);
        return;
      }
      let hostPolicy = policy;
      // get tagged policy
      if (target != "0.0.0.0") {
        hostPolicy = await this.loadPolicyAsync();
      }
      const userpass = await this._getTagUserPass();
      const result = await this._apply(hostPolicy, userpass);
      if (result && result.err) {
         // if apply error, reset to previous saved policy
        log.error('fail to apply policy,', result.err);
        if (this._policy) {
          this.policy = this._policy;
          await rclient.hsetAsync('policy:system', policyKeyName, JSON.stringify(this._policy));
        }
        return;
      }
      log.info("freeradius policy applied, freeradius server status", freeradius.getStatus());
    }).catch((err) => {
      log.error(`failed to get lock to apply ${featureName} policy`, err.message);
    });
  }
}

module.exports = FreeRadiusSensor;
