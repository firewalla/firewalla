'use strict'

let log = require("./logger.js")(__filename, "info");

let fs = require('fs');
let f = require('./Firewalla.js');

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

function isFeatureOn(featureName) {
  let config = getConfig()
  return config.features && config.features[featureName]
}

module.exports = {
  getConfig: getConfig,
  isFeatureOn: isFeatureOn
};
