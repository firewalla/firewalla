'use strict';

let log = require("./logger.js")(__filename, "info");

let fs = require('fs');
let f = require('./Firewalla.js');
let config = require('./config.js').getConfig();

let features = config.features;

exports.isOn = (feature) => {
  return feature in features && features[feature];
};

exports.isOff = (feature) => {
  return !exports.isOn(feature);
};

exports.getFeatures = () => {
  return features;
};

exports.getVersion = (feature) => {
  return features[feature];
};