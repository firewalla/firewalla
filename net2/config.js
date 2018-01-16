'use strict'

let log = require("./logger.js")(__filename, "info");

let fs = require('fs');
let f = require('./Firewalla.js');

const redis = require('redis')
const rclient = redis.createClient()

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
  return config.features && config.features[featureName]
}

function isFeatureOn_Dynamic(featureName) {
  return dynamicConfigs && !(dynamicConfigs[featureName] && dynamicConfigs[featureName] === '0')
}

function isFeatureOn(featureName) {
  return isFeatureOn_Static(featureName) && isFeatureOn_Dynamic(featureName)
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
    dynamicConfigs[featureName] = '1'
  })()
}

function disableDynamicFeature(featureName) {
  return async(() => {
    await (rclient.hsetAsync(dynamicConfigKey, featureName, '0'))
    dynamicConfigs[featureName] = '0'
  })()
}

function clearDynamicFeature(featureName) {
  return async(() => {
    await (rclient.hdel(dynamicConfigKey, featureName))
    delete dynamicConfigs[featureName]
  })()
}

function getDynamicConfigs() {
  return dynamicConfigs
}

// syncDynamicFeaturesConfigs()

// setInterval(() => {
//   syncDynamicFeaturesConfigs()
// }, 60 * 1000) // every minute

module.exports = {
  getConfig: getConfig,
  isFeatureOn: isFeatureOn,
  getDynamicConfigs: getDynamicConfigs,
  enableDynamicFeature:enableDynamicFeature,
  disableDynamicFeature:disableDynamicFeature,
  clearDynamicFeature: clearDynamicFeature,
  syncDynamicFeaturesConfigs: syncDynamicFeaturesConfigs
};
