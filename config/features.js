let log = require("../net2/logger.js")(__filename, "info");

let fs = require('fs');
let f = require('../net2/Firewalla.js');

let features = JSON.parse(fs.readFileSync(f.getFirewallaHome() + "/config/features.json", 'utf8'));

exports.isOn = (feature) => {
  return feature in features;
};

exports.isOff = (feature) => {
  return !exports.isOn(feature);
};
