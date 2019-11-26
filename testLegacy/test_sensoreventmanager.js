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

let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;

let log = require('../net2/logger.js')(__filename);

let SEM = require('../sensor/SensorEventManager.js');
let sem = SEM.getInstance();

let FWEvent = require('../sensor/Sensor.js').FWEvent;

let flag = 0;
sem.on('test', (e) => {
  flag = 1;
});

let e = new FWEvent(1, "test");
sem.emitEvent(e);

expect(flag).to.equal();


