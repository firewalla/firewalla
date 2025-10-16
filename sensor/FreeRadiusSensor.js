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
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Sensor = require('./Sensor.js').Sensor;
const sem = require('./SensorEventManager.js').getInstance();

const HostTool = require("../net2/HostTool.js");
const hostTool = new HostTool();
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const tagManager = require('../net2/TagManager.js');
const fwapc = require('../net2/fwapc.js');

const extensionManager = require('./ExtensionManager.js');
const Constants = require('../net2/Constants.js');
const featureName = 'freeradius_server';
const policyKeyName = 'freeradius_server';
const LOCK_APPLY_FREERADIUS_SERVER_POLICY = "LOCK_APPLY_FREERADIUS_SERVER_POLICY";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class FreeRadiusSensor extends Sensor {
  constructor(config) {
    super(config);

    if (f.isMain()) {
      sem.on("StartFreeRadiusServer", async (event) => {
        if (!this.featureOn) return;
        return freeradius.startServer(this._options || {});
      });

      sem.on("StopFreeRadiusServer", async (event) => {
        // if (!this.featureOn) return;
        await freeradius.stopServer(this._options || {});
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

    extensionManager.onCmd("uploadFreeRadius", async (msg, data) => {
      if (!data.path || !data.content) {
        return {
          success: false,
          error: "path or content is invalid",
        };
      }
      const result = await freeradius.saveFile(data.path, data.content);
      if (result.ok) {
        return {
          success: true,
        };
      }
      return {
        success: false,
        error: `Failed to save file ${data.path}: ${result.error}`,
      };
    });

    extensionManager.onCmd("processFreeRadius", async (msg, data) => {
      if (!data.script || !data.cmd) {
        return {
          success: false,
          error: "script or cmd is invalid",
        };
      }
      const options = await this.loadOptionsAsync();
      const result = await freeradius.processCommand(data.script, data.cmd, options);
      log.info(`Processed ${data.script} with command ${data.cmd}, result: ${result}`);
      return {
        success: true,
        result: result,
      };
    });

    extensionManager.onGet("getFreeRadiusStatus", async (msg, data) => {
      await freeradius._statusServer();
      await freeradius._watchStatus();
      const policy = await this.loadPolicyAsync();
      return {
        featureOn: fc.isFeatureOn(featureName),
        status: { pid: freeradius.pid, running: freeradius.running },
        policy: (JSON.parse(freeradius.mask(JSON.stringify(policy)))),
      };
    });
  }

  async run() {
    this.featureOn = false;
    this._policy = await this.loadPolicyAsync();
    this._options = await this.loadOptionsAsync();

    // sync ssid sta mapping once every 20 seconds to ensure consistency in case sta update message is missing somehow
    setInterval(async () => {
      this.refreshDeviceTags().catch((err) => {
        log.error(`Failed to refresh radius device tags`, err.message);
      });
    }, 120000); // every 2 minutes

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy
    })
    this.hookFeature(featureName);

    sclient.on("message", async (channel, message) => {
      switch (channel) {
        case 'radius_auth_event': {
          await this.processAuthEvent(message);
          break;
        }
      }
    });
    sclient.subscribe("radius_auth_event");
  }

  async refreshDeviceTags(options = {}) {
    log.debug("refresh device tags");
    const staStatus = await fwapc.getAllSTAStatus(true).catch((err) => {
      log.error(`Failed to get STA status from fwapc`, err.message);
      return null;
    });
    if (!_.isObject(staStatus))
      return;
    for (const [mac, staInfo] of Object.entries(staStatus)) {
      if (staInfo.dot1xUserName) {
        await this.setDeviceTag(mac, staInfo.dot1xUserName);
      }
    }
  }

  async setDeviceTag(mac, username) {
    const userTag = tagManager.getTagByRadiusUser(username);
    if (!userTag) {
      log.info(`skip set device tag ${mac} with username ${username}, user tag not found`);
      return;
    }

    let tagId = userTag.getUniqueId();
    if (userTag.getTagType() == Constants.TAG_TYPE_USER) {
      tagId = userTag.afTag && userTag.afTag.getUniqueId();
    }

    if (!tagId) {
      log.info(`skip set device tag ${mac} with username ${username}, tag ${tagId} of ${userTag.getTagType()} ${userTag.getUniqueId()} not found`);
      return;
    }

    let monitorable = await hostManager.getHostAsync(mac);
    if (!monitorable) {
      log.info(`New device ${mac} set candidate tag to ${tagId}`);
      await hostTool.setWirelessDeviceTagCandidate(mac, String(tagId));
      return;
    }

    // cleanup candidate tag
    await hostTool.deleteWirelessDeviceTagCandidate(mac);

    // check if wifi auto group is enabled on this device
    const wifiAutoGroup = monitorable.getPolicyFast(Constants.POLICY_KEY_WIFI_AUTO_GROUP);
    if (_.get(wifiAutoGroup, "state") === false) {
      log.debug(`${Constants.POLICY_KEY_WIFI_AUTO_GROUP} is not enabled on device ${mac}`);
      return;
    }

    const origPolicy = await monitorable.loadPolicyAsync();
    const policyKey = _.get(Constants.TAG_TYPE_MAP, [Constants.TAG_TYPE_GROUP, "policyKey"]);

    if (_.isEqual(origPolicy[policyKey], [tagId])) {
      log.debug(`${mac} already has tag ${username} ${tagId}`);
      return;
    }

    log.info(`set policy of ${mac} ${policyKey}:[${tagId}]`);
    await monitorable.setPolicyAsync(policyKey, [tagId], true);
  }

  async processAuthEvent(message) {
    message = "{" + message + "}"
    log.info("radius auth event", freeradius.mask(message));
    try {
      const msg = JSON.parse(message);
      if (msg) {
        const mac = msg.mac.replace(/-/g, ':').toUpperCase();
        await this.setDeviceTag(mac, msg.user_name);
      }
    } catch (err) {
      log.error("parse radius_auth_event message error", err.message, message);
      return;
    }
  }

  // policy: {radius:{clients:[{ipaddr:"", name:"", secret:""}]}}
  async _getHostPolicy() {
    const data = await rclient.hgetAsync(hostManager._getPolicyKey(), policyKeyName);
    if (data) {
      try {
        return JSON.parse(data);
      } catch (err) {
        log.warn(`fail to load policy, invalid json ${freeradius.mask(JSON.stringify(data))}`);
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
      policy[tag.getTagUid()] = p;
    }
    return policy;
  }

  async loadOptionsAsync() {
    try {
      const policyOpts = this._policy && this._policy["0.0.0.0"] && this._policy["0.0.0.0"].options || {};
      return Object.assign({}, await freeradius.loadOptionsAsync(), policyOpts);
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
    freeradius.globalOn();
    this._policy = await this.loadPolicyAsync();
    this._options = await this.loadOptionsAsync();
    log.debug("freeradius policy", freeradius.mask(JSON.stringify(this._policy)));
    log.debug("freeradius options", freeradius.mask(JSON.stringify(this._options)));
    await freeradius.prepare(this._options); // prepare in background
    // check if need to start server
    if (this.policyReady() && await freeradius.ready() && !await freeradius.isListening()) {
      await freeradius.startServer();
    }
  }

  policyReady() {
    const policy = this._policy["0.0.0.0"];
    const enabled = policy && _.isObject(policy) && Object.keys(policy).length > 0;
    return enabled || Object.keys(this._policy).length > 1;
  }

  async globalOff() {
    this.featureOn = false;
    freeradius.globalOff();
    await freeradius.cleanUp();
    // if (await freeradius.isListening()) {
    freeradius.stopServer(this._options || {});  // stop container in background
    // }
  }

  async generateOptions(options = {}) {
    try {
      await freeradius.generateOptions(options);
    } catch (err) {
      log.error("failed to generate options", err.message);
    }
  }

  // apply global policy changes, policy={radius:{}, options:{}}
  async _apply(policy, target = "0.0.0.0", force = false) {
    try {
      if (!this.featureOn) {
        log.error(`feature ${featureName} is disabled`);
        return;
      }

      if (!policy) {
        return { err: 'policy must be specified' };
      }
      const _policy = JSON.stringify(policy);

      if (!this._policy) {
        log.error(`freeradius policy not initialized`);
        return { err: `freeradius policy not initialized` };
      }

      // compare to previous policy applied
      if (this._policy[target] && _.isEqual(this._policy[target], policy) && await freeradius.isListening() && !force) {
        log.info(`policy ${policyKeyName} is not changed.`);
        return;
      }

      const { radius } = policy;
      const options = Object.assign({}, await this.loadOptionsAsync(), policy.options || {});

      // 1. apply to radius-server
      log.info("start to apply freeradius policy", freeradius.mask(JSON.stringify(radius)), options);
      // generate options
      await this.generateOptions(options);
      log.debug("configured options", options);
      const success = await freeradius.reconfigServer(target, options);

      // 2. if radius-server fails, reset to previous policy
      if (!success || !await freeradius.isListening() && this._policy[target]) {
        return { err: 'failed to reconfigure freeradius server.' };
      }

      // 3. save current policy
      this._policy[target] = JSON.parse(_policy);
      this._options = options;
    } catch (err) {
      log.error("failed to apply policy", err.message);
    }
  }

  // policy: {options:{},radius:{clients:[{"name":"","ipaddr":"","require_msg_auth":"yes|no|auto"}], users:[{username:""}]}}
  async applyPolicy(host, ip, policy) {
    if (!this.featureOn) return;
    if (!policy) return;
    log.info("start to apply policy freeradius", host.constructor.name, ip, freeradius.mask(JSON.stringify(policy)));
    try {
      await this._applyPolicy(policy, ip);
    } catch (err) {
      log.error("failed to apply policy", err.message);
    }
  }

  async revertPolicy(target = "0.0.0.0") {
    if (target == "0.0.0.0") {
      // revert to system-level policy
      if (this._policy[target]) {
        await rclient.hsetAsync('policy:system', policyKeyName, JSON.stringify(this._policy[target] || "{}"));
      } else {
        await rclient.hdelAsync(`policy:tag:${target}`, policyKeyName);
      }
    } else {
      // revert to target-level policy
      if (this._policy[target]) {
        await rclient.hsetAsync(`policy:tag:${target}`, policyKeyName, JSON.stringify(this._policy[target]));
      }
      else {
        await rclient.hdelAsync(`policy:tag:${target}`, policyKeyName);
      }
    }
    await this.generateOptions(this._options);
  }

  async _applyPolicy(policy, target = "0.0.0.0") {
    await lock.acquire(LOCK_APPLY_FREERADIUS_SERVER_POLICY, async () => {
      if (!this.featureOn) {
        log.error(`feature ${featureName} is disabled`);
        return;
      }

      let result = await this._apply(policy, target);
      if (result && result.err) {
        // if apply error, reset to previous saved policy
        log.error('fail to apply policy,', result.err);
        log.error("try to recover previous config", target, this._policy[target] || "");
        await this.revertPolicy(target);
        const systemPolicy = this._policy["0.0.0.0"] || await this._getHostPolicy();
        log.warn("reapply system-level policy", systemPolicy);
        result = await this._apply(systemPolicy, "0.0.0.0", true); // reapply system-level policy
        if (result && result.err) {
          log.error('fail to revert policy,', result.err);
          return;
        }
        return;
      }

      const status = await freeradius.getStatus(this._options);
      log.info("freeradius policy applied, freeradius server status", freeradius.mask(JSON.stringify(status)));
    }).catch((err) => {
      log.error(`failed to get lock to apply ${featureName} policy`, err.message);
    });
  }
}

module.exports = FreeRadiusSensor;

