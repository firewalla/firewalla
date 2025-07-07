/*    Copyright 2016-2025 Firewalla Inc.
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
const log = require('../net2/logger.js')(__filename);
const fc = require('../net2/config.js')
const Sensor = require('./Sensor.js').Sensor;
const extensionManager = require('./ExtensionManager.js')
const Policy = require('../alarm/Policy.js');
const Constants = require('../net2/Constants.js');
const HostTool = require('../net2/HostTool');
const hostTool = new HostTool();
const HostManager = require('../net2/HostManager.js');
const Host = require('../net2/Host.js');
const hostManager = new HostManager();
const Monitorable = require('../net2/Monitorable');

class PurposeRulePlugin extends Sensor {

  static purposeStates = {};

  constructor(config) {
    super(config);
  }

  async run() {
    const dynamicFeatures = fc.getDynamicFeatures();
    if (dynamicFeatures && dynamicFeatures.hasOwnProperty(this.featureName)) {
      PurposeRulePlugin.purposeStates[this.featureName] = dynamicFeatures[this.featureName] == "1" ? true : false;
    } else {
      // the default value of state in policy is considered true if policy is not set in system policy.
      PurposeRulePlugin.purposeStates[this.featureName] = true;
    }

    extensionManager.registerExtension(this.featureNameInPolicy, this, {
      applyPolicy: this.applyPolicy
    });

    this.hookFeature(this.featureName);
  }

  async globalOn() {
    log.info(`trigger globalOn for feature :${this.featureName} ...`);
    if (PurposeRulePlugin.purposeStates.hasOwnProperty(this.featureName)
      && PurposeRulePlugin.purposeStates[this.featureName] === true) {
      return;
    }
    PurposeRulePlugin.purposeStates[this.featureName] = true;

    const PolicyManager2 = require('../alarm/PolicyManager2.js');
    const pm2 = new PolicyManager2();
    let rules = await pm2.getPurposeRelatedPolicies(this.featureName);
    for (let rule of rules) {
      if (await this._checkHostPurposeState4Rule(rule) == false) {
        continue;  // skip the rule if the host does not have the purpose enabled
      }
      await this._reenforceRule(rule, "0");
    }

  }

  async globalOff() {
    log.info(`trigger globalOff for feature :${this.featureName} ...`);
    if (PurposeRulePlugin.purposeStates.hasOwnProperty(this.featureName)
      && PurposeRulePlugin.purposeStates[this.featureName] === false) {
      return;
    }

    PurposeRulePlugin.purposeStates[this.featureName] = false;

    const PolicyManager2 = require('../alarm/PolicyManager2.js');
    const pm2 = new PolicyManager2();
    let rules = await pm2.getPurposeRelatedPolicies(this.featureName);
    for (let rule of rules) {
      await this._reenforceRule(rule, "1");
    }
  }

  _getDeviceIdFromRule(rule) {
    if (Array.isArray(rule.scope) && rule.scope.length > 0) {
      return rule.scope[0];   // mac address format
    } else if (rule.type === 'mac') {
      return rule.target;     // mac address format
    } else if (rule.guids && rule.guids.length > 0) {
      return rule.guids[0];   // mac address format or identity format like wg_peer:getUniqueId()
    }
    return null;
  }

  async _checkHostPurposeState4Rule(rule) {
    const deviceId = this._getDeviceIdFromRule(rule);
    const device = Monitorable.getInstance(deviceId);
    if (!device) {
      return false;
    }
    const dapAdmin = await device.getPolicyAsync(this.featureNameInPolicy);
    if (dapAdmin && dapAdmin.hasOwnProperty('state') && typeof dapAdmin.state === 'boolean') {
      return dapAdmin.state;
    }
    // the default value of state in policy is considered true if policy is not set.
    return true;
  }

  // will be called only when the global option is enabled
  async applyPolicy(host, id, policy) {
    if (!host || (host.constructor.name !== "Host" && host.constructor.name !== "WGPeer") || !policy) {
      return;
    }
    const deviceId = host.getGUID();
    // the default value of state in policy is considered true if policy is not set in host policy.
    const state = (policy.state !== undefined &&  typeof policy.state === 'boolean') ? policy.state : true;

    log.info(`Applying purpose: ${this.featureNameInPolicy}, state: ${policy.state} for host ${deviceId} and global state: ${PurposeRulePlugin.purposeStates[this.featureName]}`);
    const PolicyManager2 = require('../alarm/PolicyManager2.js');
    const pm2 = new PolicyManager2();
    let rules = await pm2.getPurposeRelatedPolicies(this.featureName, deviceId);
    for (let rule of rules) {
      await this._reenforceRule(rule, PurposeRulePlugin.purposeStates[this.featureName] && state ? "0" : "1");
    }
  }

  async _reenforceRule(rule, disabled) {
    let rulePauseData = { "idleTs": "", "disabled": disabled, "updatedTime": Date.now() / 1000 };
    const newRule = new Policy(Object.assign({}, rule, rulePauseData));
    const oldRule = new Policy(rule);
    const PolicyManager2 = require('../alarm/PolicyManager2.js');
    const pm2 = new PolicyManager2();
    await pm2.updatePolicyAsync(newRule);
    pm2.tryPolicyEnforcement(newRule, "reenforce", oldRule);
  }


}


module.exports = PurposeRulePlugin;