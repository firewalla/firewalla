'use strict'

let log = require("./logger.js")(__filename, "info");

let fs = require('fs');
let f = require('./Firewalla.js');

const redis = require('redis')
const rclient = redis.createClient()
const sclient_publish = redis.createClient()
const sclient_subscribe = redis.createClient()
sclient_publish.setMaxListeners(0)
sclient_subscribe.setMaxListeners(0)

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const dynamicConfigKey = "sys:features"

var dynamicConfigs = {}

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
  return config.userFeatures && config.userFeatures[featureName]
}

function isFeatureOn_Dynamic(featureName) {
  return dynamicConfigs && dynamicConfigs[featureName] && dynamicConfigs[featureName] === '1'
}

function isFeatureOn(featureName) {
  if(isFeatureOn_Static(featureName) || isFeatureOn_Dynamic(featureName)) {
    return true
  } else {
    return false
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
    sclient_publish.publish("config:feature:dynamic:enable", featureName)
    dynamicConfigs[featureName] = '1'
  })()
}

function disableDynamicFeature(featureName) {
  return async(() => {
    await (rclient.hsetAsync(dynamicConfigKey, featureName, '0'))
    sclient_publish.publish("config:feature:dynamic:disable", featureName)
    dynamicConfigs[featureName] = '0'
  })()
}

function clearDynamicFeature(featureName) {
  return async(() => {
    await (rclient.hdel(dynamicConfigKey, featureName))
    sclient_publish.publish("config:feature:dynamic:clear", featureName)
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

  return merged
}

sclient_subscribe.subscribe("config:feature:dynamic:enable")
sclient_subscribe.subscribe("config:feature:dynamic:disable")
sclient_subscribe.subscribe("config:feature:dynamic:clear")

sclient_subscribe.on("message", (channel, message) => {
  log.info(`got message from ${channel}: ${message}`)
  switch(channel) {
  case "config:feature:dynamic:enable":
    dynamicConfigs[message] = '1'
    break
  case "config:feature:dynamic:disable":
    dynamicConfigs[message] = '0'
    break
  case "config:feature:dynamic:clear":
    delete dynamicConfigs[message]
    break
  }  
});

syncDynamicFeaturesConfigs()

setInterval(() => {
  syncDynamicFeaturesConfigs()
}, 60 * 1000) // every minute

module.exports = {
  getConfig: getConfig,
  isFeatureOn: isFeatureOn,
  getFeatures: getFeatures,
  getDynamicConfigs: getDynamicConfigs,
  enableDynamicFeature:enableDynamicFeature,
  disableDynamicFeature:disableDynamicFeature,
  clearDynamicFeature: clearDynamicFeature,
  syncDynamicFeaturesConfigs: syncDynamicFeaturesConfigs
};
