/*    Copyright 2016 Firewalla LLC
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
'use strict'

let chai = require('chai');
let should = chai.should;
let expect = chai.expect;
let assert = chai.assert;

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let sample = require('./sample_data');

let Promise = require('bluebird');

let AppTool = require('../net2/AppTool');
let appTool = new AppTool();

describe('AppTool', () => {
  let appInfo = {
    "appID": "com.rottiesoft.circle",
    "version": "1.17",
    "platform": "ios"
  }

  it('should support isAppReadyForNewDeviceHandler', (done) => {
    expect(appTool.isAppReadyForNewDeviceHandler(appTool)).to.be.true;
    expect(appTool.isAppReadyForNewDeviceHandler(undefined)).to.be.false;
    done();
  })

  it('should support isAppReadyToDiscardLegacyFlowInfo', (done) => {
    expect(appTool.isAppReadyToDiscardLegacyFlowInfo(appTool)).to.be.true;
    expect(appTool.isAppReadyToDiscardLegacyFlowInfo(undefined)).to.be.false;
    done();
  })

  it('should support isAppReadyToDiscardLegacyAlarm', (done) => {
    expect(appTool.isAppReadyToDiscardLegacyAlarm(appTool)).to.be.true;
    expect(appTool.isAppReadyToDiscardLegacyAlarm(undefined)).to.be.false;
    done();
  })
});
