/*    Copyright 2019-2021 Firewalla Inc.
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

let log = require("./logger.js")(__filename, "info");

let config = require('./config.js').getConfig();

let features = config.features;

exports.isOn = (feature) => {
  const c = exports.getConfig(feature)
  return c === true || c.enabled;
};

exports.getConfig = feature => {
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
