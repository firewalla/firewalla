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

const log = require('../net2/logger.js')(__filename);
const _ = require('lodash');
const cloudCache = require('../extension/cloudcache/cloudcache.js');
const SuricataControl = require('../net2/SuricataControl.js');
const Sensor = require('./Sensor.js').Sensor;
const AsyncLock = require('../vendor_lib/async-lock/index.js');
const lock = new AsyncLock();
const LOCK_PROCESS_SC_RULES = "LOCK_PROCESS_SC_RULES";
const extensionManager = require('./ExtensionManager.js');
const f = require('../net2/Firewalla.js');

const SOURCE_BASIC = "basic";
const SOURCE_MSP = "msp";

const basicPolicyKeyName = `${SOURCE_BASIC}_suricata`;
const mspPolicyKeyName = `${SOURCE_MSP}_suricata`;

class SuricataRuleSetSensor extends Sensor {
  async run() {
    this.mspEnabled = false;
    this.basicEnabled = false;
    this.effectiveMSPRuleSets = {}; // rule sets currently applied by MSP policy
    this.configuredMSPRuleSets = {}; // rule sets configured by MSP policy
    this.effectiveBasicRuleSets = {}; // rule sets currently applied by basic policy
    this.configuredBasicRuleSets = {}; // rule sets configured by basic policy
    await SuricataControl.prepareAssets();
    await SuricataControl.cleanupRules(SOURCE_BASIC).catch((err) => {});
    await SuricataControl.cleanupRules(SOURCE_MSP).catch((err) => {});
    this.hookFeature(basicPolicyKeyName);
    this.hookFeature(mspPolicyKeyName);

    if (f.isMain()) {
      extensionManager.registerExtension(basicPolicyKeyName, this, {
        applyPolicy: this.applyBasicPolicy
      });
      extensionManager.registerExtension(mspPolicyKeyName, this, {
        applyPolicy: this.applyMSPPolicy
      });
    }
  }

  async globalOn(featureName) {
    if (featureName === basicPolicyKeyName) {
      this.basicEnabled = true;
      await this.enforceRuleSets(this.configuredBasicRuleSets, SOURCE_BASIC);
    } else if (featureName === mspPolicyKeyName) {
      this.mspEnabled = true;
      await this.enforceRuleSets(this.configuredMSPRuleSets, SOURCE_MSP);
    }
  }

  async globalOff(featureName) {
    if (featureName === basicPolicyKeyName) {
      this.basicEnabled = false;
      await this.enforceRuleSets([], SOURCE_BASIC);
    } else if (featureName === mspPolicyKeyName) {
      this.mspEnabled = false;
      await this.enforceRuleSets([], SOURCE_MSP);
    }
  }

  async applyMSPPolicy(host, ip, policy) {
    if (ip !== "0.0.0.0") {
      log.error(`${mspPolicyKeyName} policy is only supported on global level`);
      return;
    }
    if (!policy) {
      log.error(`Policy is required for ${mspPolicyKeyName}`);
      return;
    }

    const {ruleSets = []} = policy;

    if (!_.isArray(ruleSets)) {
      log.error(`ruleSets must be an array in ${mspPolicyKeyName} policy`);
      return;
    }

    log.info(`Applying MSP suricata rules policy:`, policy);
    this.configuredMSPRuleSets = ruleSets;
    if (this.mspEnabled) {
      await this.enforceRuleSets(ruleSets, SOURCE_MSP);
    }
  }

  async applyBasicPolicy(host, ip, policy) {
    if (ip !== "0.0.0.0") {
      log.error(`${basicPolicyKeyName} policy is only supported on global level`);
      return;
    }
    
    if (!policy) {
      log.error(`Policy is required for ${basicPolicyKeyName}`);
      return;
    }

    const {ruleSets = []} = policy;

    if (!_.isArray(ruleSets)) {
      log.error(`ruleSets must be an array in ${basicPolicyKeyName} policy`);
      return;
    }

    log.info(`Applying basic suricata rules policy:`, policy);
    this.configuredBasicRuleSets = ruleSets;
    if (this.basicEnabled) {
      await this.enforceRuleSets(ruleSets, SOURCE_BASIC);
    }
  }

  async enforceRuleSets(ruleSets, source = SOURCE_MSP) {
    // only effective rule sets are updated in this function
    if (!_.isArray(ruleSets))
      return;
    
    const effectiveRuleSets = source === SOURCE_BASIC ? this.effectiveBasicRuleSets : this.effectiveMSPRuleSets;
    
    await lock.acquire(LOCK_PROCESS_SC_RULES, async () => {
      for (const ruleSet of ruleSets) {
        const {id} = ruleSet;
        if (!id) {
          log.error(`"id" is not defined in rule set config`, ruleSet);
          continue;
        }
        if (_.has(effectiveRuleSets, id) && _.isEqual(effectiveRuleSets[id], ruleSet)) {
          await this.refreshRuleSet(ruleSet).catch((err) => {
            log.error(`Failed to refresh rule set ${id}`, err.message);
          });
          continue;
        }
        if (!_.has(effectiveRuleSets, id)) {
          log.info(`A new rule set is configured from ${source}`, ruleSet);
        } else {
          log.info(`Rule set config is updated from ${source}`, effectiveRuleSets[id], ruleSet);
          await this.deleteRuleSet(ruleSet).catch((err) => {
            log.error(`Failed to delete rule set ${id}`, err.message);
          });
        }
        await this.saveRuleSet(ruleSet, source).then(() => {
          effectiveRuleSets[id] = ruleSet; // only add to effectiveRuleSets on success
        }).catch((err) => {
          log.error(`Failed to save rule set ${id}`, err.message);
        });
      }
      for (const ruleSetId of Object.keys(effectiveRuleSets).filter(id => !ruleSets.some(r => r.id === id))) {
        const ruleSet = effectiveRuleSets[ruleSetId];
        log.info(`Rule set ${ruleSetId} is removed from ${source}`, ruleSet);
        await this.deleteRuleSet(ruleSet).catch((err) => {
          log.error(`Failed to delete rule set ${ruleSetId}`, err.message);
        });
        delete effectiveRuleSets[ruleSetId];
      }
    });
  }

  async refreshRuleSet(ruleSetObj) {
    const {id, from = "assets", hashsetId} = ruleSetObj;
    switch (from) {
      case "assets": {
        break;
      }
      case "hashset": {
        const hashsetName = `${hashsetId || id}`;
        // forceLoad will check sha256 and download the updated content if local sha256 is different from cloud sha256
        await cloudCache.forceLoad(hashsetName);
        break;
      }
      default: {
        log.error("Unsupported rule set type", ruleSetObj);
      }
    }
  }

  async saveRuleSet(ruleSetObj, source = SOURCE_MSP) {
    const {id, from = "assets", hashsetId} = ruleSetObj;
    switch (from) {
      case "assets": {
        await SuricataControl.addRulesFromAssets(id);
        break;
      }
      case "hashset": {
        const hashsetName = `${hashsetId || id}`;
        await cloudCache.enableCache(hashsetName, async (content) => {
          if (!content) {
            log.error(`Rule set ${id} hashset ${hashsetName} is unavailable from cloud`);
            return;
          }
          try {
            const rules = JSON.parse(content);
            if (_.isArray(rules)) {
              const filename = `${id}.rules`;
              await SuricataControl.saveRules(rules, filename, source);
            }
          } catch (err) {
            log.error(`Failed to save suricata cloud rule set ${id}`, err.message);
          }
        });
        break;
      }
      default: {
        log.error(`Unsupported rule set type`, ruleSetObj);
      }
    }
  }

  async deleteRuleSet(ruleSetObj, source = SOURCE_MSP) {
    const {id, from = "assets", hashsetId} = ruleSetObj;
    switch (from) {
      case "assets": {
        await SuricataControl.deleteRulesFromAssets(id);
        break;
      }
      case "hashset": {
        const hashsetName = `${hashsetId || id}`;
        await cloudCache.disableCache(hashsetName);
        const filename = `${id}.rules`;
        await SuricataControl.deleteRules(filename, source);
        break;
      }
      default: {
        log.error(`Unsupported rule set type`, ruleSetObj);
      }
    }
  }
}

module.exports = SuricataRuleSetSensor;