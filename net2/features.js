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

let log = require("./logger.js")(__filename);

let fc = require('./config.js')

// Note that this is not userFeatures

exports.isOn = (feature) => {
  const c = exports.getConfig(feature)
  return c === true || c.enabled;
};

exports.getConfig = feature => {
  const features = fc.getConfig().features
  return features && features[feature];
};


exports.isOff = (feature) => {
  return !exports.isOn(feature);
};

exports.list = () => {
  const features = fc.getConfig().features
  return features && Object.keys(features) || []
};
