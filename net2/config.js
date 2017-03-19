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

    // user config will override system default config file
    config = Object.assign({}, defaultConfig, userConfig);
  }
  return config;
}


module.exports = {
  getConfig: getConfig
};
