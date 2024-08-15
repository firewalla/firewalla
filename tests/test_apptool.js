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

let sample = require('./sample_data');

let AppTool = require('../net2/AppTool');
let appTool = new AppTool();

describe('AppTool', () => {
  let appInfo = {
    "appID": "com.rottiesoft.circle",
    "version": "1.17",
    "platform": "ios"
  }

  it('should support isAppReadyToDiscardLegacyFlowInfo', (done) => {
    expect(appTool.isAppReadyToDiscardLegacyFlowInfo(appInfo)).to.be.true;
    expect(appTool.isAppReadyToDiscardLegacyFlowInfo(undefined)).to.be.false;
    done();
  })

  it('should support isAppReadyToDiscardLegacyAlarm', (done) => {
    expect(appTool.isAppReadyToDiscardLegacyAlarm(appInfo)).to.be.true;
    expect(appTool.isAppReadyToDiscardLegacyAlarm(undefined)).to.be.false;
    done();
  })
});
