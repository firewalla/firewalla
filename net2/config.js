'use strict'

let log = require("./logger.js")(__filename, "info");

let fs = require('fs');
let f = require('./Firewalla.js');

const redis = require('redis')
const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const dynamicConfigKey = "sys:features"

var dynamicConfigs = {}

let callbacks = {}

let config = null;

function getConfig() {
  if(!config) {
    let defaultConfig = JSON.parse(fs.readFileSync(f.getFirewallaHome() + "/net2/config.json", 'utf8'));
    let userConfigFile = f.getUserConfigFolder() + "/config.json";
    let userConfig = {};
    if(fs.existsSync(userConfigFile)) {
      userConfig = JSON.parse(fs.readFileSync(userConfigFile, 'utf8'));
    }

    let testConfig = {};
    if(process.env.NODE_ENV === 'test') {
      let testConfigFile = f.getUserConfigFolder() + "/config.test.json";
      if(fs.existsSync(testConfigFile)) {
        testConfig = JSON.parse(fs.readFileSync(testConfigFile, 'utf8'));
        log.warn("Test config is being used", testConfig, {});
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

function isFeatureOn(featureName) {
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
    return false // default disabled
  }
}

function syncDynamicFeaturesConfigs() {
  return async(() => {
    let configs = await (rclient.hgetallAsync(dynamicConfigKey))
    if(configs) {
      dynamicConfigs = configs
    } else {
      dynamicConfigs = {}
    }
  })()
}

function enableDynamicFeature(featureName) {
  return async(() => {
    await (rclient.hsetAsync(dynamicConfigKey, featureName, '1'))
    pclient.publish("config:feature:dynamic:enable", featureName)
    dynamicConfigs[featureName] = '1'
  })()
}

function disableDynamicFeature(featureName) {
  return async(() => {
    await (rclient.hsetAsync(dynamicConfigKey, featureName, '0'))
    pclient.publish("config:feature:dynamic:disable", featureName)
    dynamicConfigs[featureName] = '0'
  })()
}

function clearDynamicFeature(featureName) {
  return async(() => {
    await (rclient.hdel(dynamicConfigKey, featureName))
    pclient.publish("config:feature:dynamic:clear", featureName)
    delete dynamicConfigs[featureName]
  })()
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
  log.info(`got message from ${channel}: ${message}`)
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

module.exports = {
  getConfig: getConfig,
  isFeatureOn: isFeatureOn,
  getFeatures: getFeatures,
  getDynamicConfigs: getDynamicConfigs,
  enableDynamicFeature:enableDynamicFeature,
  disableDynamicFeature:disableDynamicFeature,
  clearDynamicFeature: clearDynamicFeature,
  syncDynamicFeaturesConfigs: syncDynamicFeaturesConfigs,
  onFeature: onFeature  
};
