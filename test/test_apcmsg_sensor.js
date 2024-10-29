/*    Copyright 2016-2024 Firewalla Inc.
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
let expect = chai.expect;

const APCMsgSensor = require('../sensor/APCMsgSensor.js');
const sysManager = require('../net2/SysManager.js');
const fireRouter = require('../net2/FireRouter.js')
const log = require('../net2/logger.js')(__filename);

describe('Test apc block message', function(){
  this.timeout(30000);

  before(async() => {
    this.plugin = new APCMsgSensor({});

    sysManager.iptablesReady = true;
    await fireRouter.init();
    await sysManager.updateAsync();
  });

  after((done) => {
    done();
  });

  it('should process apc block message', async() => {
    this.plugin.processApcBlockFlowMessage(JSON.stringify({
        "src":"192.168.1.100","dst":"192.168.1.200",
        "sport":12345,"dport":54321, "smac":"00:11:22:33:44:55",
        "dmac":"00:22:44:66:88:11","ct":3,"ts":Date.now()/1000}));
  });

});
