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
const fc = require('../net2/config.js')
const f = require('../net2/Firewalla.js');
const log = require('../net2/logger.js')(__filename);
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const rclient = require('../util/redis_manager.js').getRedisClient();
const Sensor = require('./Sensor.js').Sensor;
const sem = require('./SensorEventManager.js').getInstance();

const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const tagManager = require('../net2/TagManager.js');

const extensionManager = require('./ExtensionManager.js');
const featureName = 'freeradius_server';
const policyKeyName = 'freeradius_server';
const LOCK_APPLY_FREERADIUS_SERVER_POLICY = "LOCK_APPLY_FREERADIUS_SERVER_POLICY";

class FreeRadiusSensor extends Sensor {
  constructor(config) {
    super(config);

    if (f.isMain()) {
      sem.on("StartFreeRadiusServer", async (event) => {
        if (!this.featureOn) return;
        return freeradius.startServer();
      });

      sem.on("StopFreeRadiusServer", async (event) => {
        if (!this.featureOn) return;
        await freeradius.stopServer();
      });

      sem.on("ReloadFreeRadiusServer", async (event) => {
        if (!this.featureOn) return;
        await freeradius.reloadServer();
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

    extensionManager.onCmd("reloadFreeRadius", async (msg, data) => {
      sem.sendEventToFireMain({
        type: "ReloadFreeRadiusServer",
      });
    });

    extensionManager.onGet("getFreeRadiusStatus", async (msg, data) => {
      await freeradius._statusServer();
      await freeradius._watchStatus();
      const policy = await this.loadPolicyAsync();
      return {
        featureOn: fc.isFeatureOn(featureName),
        status: { pid: freeradius.pid, running: freeradius.running },
        policy: policy,
      };
    });
  }

  async run() {
    this.featureOn = false;
    this._policy = null;

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy
    })
    this.hookFeature(featureName);
  }


  // policy: {radius:{clients:[{ipaddr:"", name:"", secret:""}]}}
  async _getHostPolicy() {
    const data = await rclient.hgetAsync(hostManager._getPolicyKey(), policyKeyName);
    if (data) {
      try {
        return JSON.parse(data);
      } catch (err) {
        log.warn(`fail to load policy, invalid json ${data}`);
        return {};
      };
    }
  }

  // policy: {radius:{users:[{username:"", passwd:"", tag:""}]}}
  async _getTagPolicy() {
    const policy = {}
    const tags = await tagManager.getPolicyTags(policyKeyName);
    for (const tag of tags) {
      const p = await tag.getPolicyAsync(policyKeyName);
      policy["tag:" + tag.getTagUid()] = p;
    }
    return policy;
  }

  async loadOptionsAsync() {
    try {
      return await freeradius.loadOptionsAsync();
    } catch (err) {
      log.error("failed to load options", err.message);
      return {};
    }
  }

  async loadPolicyAsync() {
    const hostPolicy = await this._getHostPolicy();
    const tagPolicy = await this._getTagPolicy();
    return { "0.0.0.0": hostPolicy, ...tagPolicy };
  }

  // global on/off
  async globalOn() {
    this.featureOn = true;
    this._policy = await this.loadPolicyAsync();
    this._options = await this.loadOptionsAsync();
    log.info("freeradius policy", this._policy);
    freeradius.prepare(); // prepare in background
  }

  async globalOff() {
    this.featureOn = false;
    if (await freeradius.isListening()) {
      freeradius.stopServer();  // stop container in background
    }
  }

  async generateOptions(options = {}) {
    try {
      await freeradius.generateOptions(options);
    } catch (err) {
      log.error("failed to generate options", err.message);
    }
  }

  // apply global policy changes, policy={radius:{}, options:{}}
  async _apply(policy, target = "0.0.0.0") {
    if (!policy) {
      return { err: 'policy must be specified' };
    }
    const _policy = JSON.stringify(policy);

    // compare to previous policy applied
    if (_.isEqual(this._policy[target], policy) && await freeradius.isListening()) {
      log.info(`policy ${policyKeyName} is not changed.`);
      return;
    }
    const { radius, options } = policy;

    // 1. apply to radius-server
    log.info("start to apply freeradius policy", radius, options);
    // generate options
    await this.generateOptions(options);
    log.debug("configured options", options);
    const success = await freeradius.reconfigServer(options);

    // 2. if radius-server fails, reset to previous policy
    if (!success || !await freeradius.isListening() && this._policy[target]) {
      return { err: 'failed to reconfigure freeradius server.' };
    }

    // 3. save current policy
    this._policy[target] = JSON.parse(_policy);
    this._options = options;
  }

  // policy: {options:{},radius:{clients:[{"name":"","ipaddr":"","require_msg_auth":"yes|no|auto"}], users:[{username:""}]}}
  async applyPolicy(host, ip, policy) {
    if (!this.featureOn) return;
    if (!policy) return;
    log.info("start to apply policy freeradius", host.constructor.name, ip, policy);
    try {
      await this._applyPolicy(policy, ip);
    } catch (err) {
      log.error("failed to apply policy", err.message);
    }
  }

  async revertPolicy(target = "0.0.0.0") {
    if (this._policy[target]) {
      if (target == "0.0.0.0") {
        await rclient.hsetAsync('policy:system', policyKeyName, JSON.stringify(this._policy[target]));
      } else {
        await rclient.hsetAsync(`policy:${target}`, policyKeyName, JSON.stringify(this._policy[target]));
      }
      await this.generateOptions(this._options);
    }
  }

  async _applyPolicy(policy, target = "0.0.0.0") {
    await lock.acquire(LOCK_APPLY_FREERADIUS_SERVER_POLICY, async () => {
      if (!this.featureOn) {
        log.error(`feature ${featureName} is disabled`);
        return;
      }

      const result = await this._apply(policy, target);
      if (result && result.err) {
        // if apply error, reset to previous saved policy
        log.error('fail to apply policy,', result.err);
        if (this._policy[target]) {
          log.error("cannot apply freeradius policy, try to recover previous config", target, this._policy[target]);
          await this.revertPolicy(target);
          const result = await this._apply(this._policy, target);
          if (result && result.err) {
            log.error('fail to revert policy,', result.err);
            return;
          }
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

