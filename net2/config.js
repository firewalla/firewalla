/*    Copyright 2019 Firewalla INC
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

'use strict'

const log = require("./logger.js")(__filename);

const fs = require('fs');
const f = require('./Firewalla.js');
const cp = require('child_process');

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const dynamicConfigKey = "sys:features"

var dynamicConfigs = {}

let callbacks = {}

let config = null;
let userConfig = null;

const util = require('util');
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);

async function updateUserConfig(updatedPart) {
  await getUserConfig(true);
  userConfig = Object.assign({}, userConfig, updatedPart);
  let userConfigFile = f.getUserConfigFolder() + "/config.json";
  await writeFileAsync(userConfigFile, JSON.stringify(userConfig, null, 2), 'utf8'); // pretty print
  getConfig(true);
}

function updateUserConfigSync(updatedPart) {
  getConfig(true);
  userConfig = Object.assign({}, userConfig, updatedPart);
  let userConfigFile = f.getUserConfigFolder() + "/config.json";
  fs.writeFileSync(userConfigFile, JSON.stringify(userConfig, null, 2), 'utf8'); // pretty print
  getConfig(true);
}

async function removeUserNetworkConfig() {
  await getUserConfig(true);
  
  delete userConfig.alternativeInterface;
  delete userConfig.secondaryInterface;
  delete userConfig.wifiInterface;
  delete userConfig.dhcpLeaseTime;
  
  let userConfigFile = f.getUserConfigFolder() + "/config.json";
  await writeFileAsync(userConfigFile, JSON.stringify(userConfig, null, 2), 'utf8'); // pretty print
}

async function getUserConfig(reload) {
  if (!userConfig || reload === true) {
    let userConfigFile = f.getUserConfigFolder() + "/config.json";
    userConfig = {};
    if (fs.existsSync(userConfigFile)) {
      userConfig = JSON.parse(await readFileAsync(userConfigFile, 'utf8'));
    }
  }
  return userConfig;
}

function getConfig(reload) {
  if(!config || reload === true) {
    let defaultConfig = JSON.parse(fs.readFileSync(f.getFirewallaHome() + "/net2/config.json", 'utf8'));
    let userConfigFile = f.getUserConfigFolder() + "/config.json";
    userConfig = {};
    for (let i = 0; i !== 5; i++) {
      try {
        if (fs.existsSync(userConfigFile)) {
          // let fileJson = fs.readFileSync(userConfigFile, 'utf8');
          // log.info(`getConfig fileJson:${fileJson}` + new Error("").stack);
          // userConfig = JSON.parse(fileJson);
          userConfig = JSON.parse(fs.readFileSync(userConfigFile, 'utf8'));
          break;
        }
      } catch (err) {
        log.error(`Error parsing user config, retry count ${i}`, err);
        cp.execSync('sleep 1');
      }
    }

    let testConfig = {};
    if(process.env.NODE_ENV === 'test') {
      let testConfigFile = f.getUserConfigFolder() + "/config.test.json";
      if(fs.existsSync(testConfigFile)) {
        testConfig = JSON.parse(fs.readFileSync(testConfigFile, 'utf8'));
        log.warn("Test config is being used", testConfig);
      }
    }

    // user config will override system default config file
    config = Object.assign({}, defaultConfig, userConfig, testConfig);
  }
  return config;
}

function isFeatureOn_Static(featureName) {
  let config = getConfig()
  if(config.userFeatures && featureName in config.userFeatures) {
    if(config.userFeatures[featureName]) {
      return true
    } else {
      return false
    }
  } else {
    return undefined
  }
}

// undefined: feature not exists
// true: feature enabled
// false: feature disabled
function isFeatureOn_Dynamic(featureName) {
  if(dynamicConfigs && featureName in dynamicConfigs) {
    if(dynamicConfigs[featureName] === '1' ) {
      return true
    } else {
      return false
    }
  } else {
    return undefined
  }
}

function isFeatureHidden(featureName) {
  if(!f.isProductionOrBeta()) {
    return false; // for dev mode, never hide features
  }
  
  const config = getConfig();
  if(config.hiddenFeatures && 
    Array.isArray(config.hiddenFeatures) && 
    config.hiddenFeatures.includes(featureName)) {
    return true;
  } else {
    return false;
  }
}

function isFeatureOn(featureName, defaultValue) {
  if(isFeatureHidden(featureName)) {
    return false;
  }

  const dynamicFlag = isFeatureOn_Dynamic(featureName)
  if(dynamicFlag !== undefined) {
    return dynamicFlag
  }

  const staticFlag = isFeatureOn_Static(featureName)
  if(staticFlag !== undefined) {
    return staticFlag
  } else {
    return defaultValue || false // default disabled
  }
}

async function syncDynamicFeaturesConfigs() {
  let configs = await rclient.hgetallAsync(dynamicConfigKey);
  if(configs) {
    dynamicConfigs = configs
  } else {
    dynamicConfigs = {}
  }
}

async function enableDynamicFeature(featureName) {
  await rclient.hsetAsync(dynamicConfigKey, featureName, '1');
  pclient.publish("config:feature:dynamic:enable", featureName)
  dynamicConfigs[featureName] = '1'
}

async function disableDynamicFeature(featureName) {
  await rclient.hsetAsync(dynamicConfigKey, featureName, '0');
  pclient.publish("config:feature:dynamic:disable", featureName)
  dynamicConfigs[featureName] = '0'
}

async function clearDynamicFeature(featureName) {
  await rclient.hdel(dynamicConfigKey, featureName);
  pclient.publish("config:feature:dynamic:clear", featureName)
  delete dynamicConfigs[featureName]
}

function getDynamicConfigs() {
  return dynamicConfigs
}

function getFeatures() {
  let staticFeatures = getConfig().userFeatures
  let dynamicFeatures = getDynamicConfigs()

  let x = {}

  let merged = Object.assign(x, staticFeatures, dynamicFeatures)

  for(let key in merged) {
    if(merged[key] == '0') {
      merged[key] = false
    }

    if(merged[key] == '1') {
      merged[key] = true
    }
  }

  const hiddenFeatures = getConfig().hiddenFeatures;

  if(f.isProductionOrBeta()) { // only apply hidden features for prod or beta
    if(hiddenFeatures && Array.isArray(hiddenFeatures)) {
      hiddenFeatures.forEach((f) => {
        if(f in merged) {
          delete merged[f];  // should be filtered out if hiddenFeatures contain the feature, this can force this feature not seen from app side
        }
      });
    }
  }  

  return merged
}

sclient.subscribe("config:feature:dynamic:enable")
sclient.subscribe("config:feature:dynamic:disable")
sclient.subscribe("config:feature:dynamic:clear")

sclient.on("message", (channel, message) => {
  log.debug(`got message from ${channel}: ${message}`)
  const theFeature = message
  switch(channel) {
  case "config:feature:dynamic:enable":
    dynamicConfigs[theFeature] = '1'
    if(callbacks[theFeature]) {
      callbacks[theFeature].forEach((c) => {
        c(theFeature, true)
      })
    }
    break
  case "config:feature:dynamic:disable":
    dynamicConfigs[theFeature] = '0'
    if(callbacks[theFeature]) {
      callbacks[theFeature].forEach((c) => {
        c(theFeature, false)
      })
    }
    break
  case "config:feature:dynamic:clear":
    delete dynamicConfigs[theFeature]
    break
  }  
});

syncDynamicFeaturesConfigs()

setInterval(() => {
  syncDynamicFeaturesConfigs()
}, 60 * 1000) // every minute



function onFeature(feature, callback) {
  if(!callbacks[feature]) {
    callbacks[feature] = []
  }

  callbacks[feature].push(callback)
}

function getTimingConfig(key) {
  const config = getConfig();
  return config && config.timing && config.timing[key];
}

function getSimpleVersion() {
  const hash = f.getLatestCommitHash();
  const version = getConfig() && getConfig().version;
  return `${version}-${hash}`;
}

module.exports = {
  updateUserConfig: updateUserConfig,
  updateUserConfigSync: updateUserConfigSync,
  getConfig: getConfig,
  getSimpleVersion: getSimpleVersion,
  getUserConfig: getUserConfig,
  getTimingConfig: getTimingConfig,
  isFeatureOn: isFeatureOn,
  getFeatures: getFeatures,
  getDynamicConfigs: getDynamicConfigs,
  enableDynamicFeature:enableDynamicFeature,
  disableDynamicFeature:disableDynamicFeature,
  clearDynamicFeature: clearDynamicFeature,
  syncDynamicFeaturesConfigs: syncDynamicFeaturesConfigs,
  onFeature: onFeature,
  removeUserNetworkConfig: removeUserNetworkConfig
};
