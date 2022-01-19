/*    Copyright 2019-2020 Firewalla INC
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

const complexNodes = [ 'sensors', 'apiSensors', 'features', 'userFeatures', 'bro' ]
const dynamicConfigKey = "sys:features"

var dynamicConfigs = {}
let cloudConfigs = {}

let callbacks = {}

let config = null;
let userConfig = null;

const util = require('util');
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);

const platform = require('../platform/PlatformLoader').getPlatform()

const { rrWithErrHandling } = require('../util/requestWrapper.js')

async function initCloudConfig() {
  let configServerUrl = null;
  if (f.isDevelopmentVersion()) configServerUrl = 'https://s3-us-west-2.amazonaws.com/fireapp/box_dev.json'
  if (f.isAlpha()) configServerUrl = 'https://s3-us-west-2.amazonaws.com/fireapp/box_alpha.json'
  if (f.isProductionOrBeta()) configServerUrl = 'https://s3-us-west-2.amazonaws.com/fireapp/box.json'
  
  if(configServerUrl) {
    const options = {
      uri: configServerUrl,
      family: 4,
      method: 'GET',
      maxAttempts: 5,
      retryDelay: 1000,
      json: true
    };
    const response = await rrWithErrHandling(options).catch(err=>log.error("request url error", err))
    if (response) {
      log.info("Load cloud default config successfully.");
      cloudConfigs = response.body;
    }
  }
}

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

function getPlatformConfig() {
  const path = `${f.getFirewallaHome()}/platform/${platform.getName()}/files/config.json`;
  if (fs.existsSync(path))
    try {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch (err) {
      log.error('Error parsing platform config', err)
    }

  return {}
}

function getConfig(reload) {
  if(!config || reload === true) {
    const defaultConfig = JSON.parse(fs.readFileSync(f.getFirewallaHome() + "/net2/config.json", 'utf8'));

    const platformConfig = getPlatformConfig()

    const userConfigFile = f.getUserConfigFolder() + "/config.json";
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
    config = Object.assign({}, defaultConfig, platformConfig, userConfig, testConfig);

    // 1 more level of Object.assign grants more flexibility to configurations
    for (const key of complexNodes) {
      config[key] = Object.assign({}, defaultConfig[key], platformConfig[key], userConfig[key], testConfig[key])
    }
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

function isFeatureOnCloud(featureName) {
  if (cloudConfigs && cloudConfigs.userFeatures && featureName in cloudConfigs.userFeatures) {
    if(cloudConfigs.userFeatures[featureName]) 
      return true;
    else 
      return false;
  }
  return undefined;
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

  const cloudConfigFlag = isFeatureOnCloud(featureName)
  if (cloudConfigFlag !== undefined) return cloudConfigFlag;

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

function getCloudConfigs() {
  return cloudConfigs
}

function getFeatures() {
  let staticFeatures = getConfig().userFeatures
  let dynamicFeatures = getDynamicConfigs()
  let cloudFeatures = getCloudConfigs().userFeatures

  let x = {}

  let merged = Object.assign(x, staticFeatures, cloudFeatures, dynamicFeatures)

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

function isMajorVersion() {
  const MAJOR_VERSION_MAX_LENGTH = 3;
  const version = getConfig() && getConfig().version;
  const versionRegex = /\d+\.(\d+)/;
  const matchResult = versionRegex.exec(version);
  const decimalPart = matchResult[1];
  return decimalPart.length <= MAJOR_VERSION_MAX_LENGTH;
}

module.exports = {
  initCloudConfig: initCloudConfig,
  updateUserConfig: updateUserConfig,
  updateUserConfigSync: updateUserConfigSync,
  getConfig: getConfig,
  getSimpleVersion: getSimpleVersion,
  isMajorVersion: isMajorVersion,
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
