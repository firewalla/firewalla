/*    Copyright 2016 - 2019 Firewalla INC 
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

let chai = require('chai');
let expect = chai.expect;

let AdvancedNmapSensor = require('../sensor/AdvancedNmapSensor');
let sensor = new AdvancedNmapSensor();

sensor.networkRange = "10.0.1.189";
// sensor.networkRange = "192.168.56.1/24";

sensor.runOnce();

setTimeout(() => {
  process.exit(0);
}, 70000);