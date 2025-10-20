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
    // policy
    this.plugin.processApcBlockFlowMessage(JSON.stringify({
        "src":"192.168.1.100","dst":"192.168.1.200", "pid":9, "action":"block",
        "sport":12345,"dport":54321, "smac":"00:11:22:33:44:55", "proto": "udp",
        "dmac":"00:22:44:66:88:11","ct":3,"ts":Date.now()/1000}));

    // group isolate
    this.plugin.processApcBlockFlowMessage(JSON.stringify({
        "action":"block","pid":0,"src":"192.168.242.124","dst":"192.168.242.79",
        "sport":5353,"dport":5353,"smac":"30:D5:3E:CF:F8:76","dmac":"CC:08:FA:61:CC:8B","ct":1,
        "ts":Date.now()/1000,"proto":"udp","iso_lvl":3,"gid":820,"iso_ext":true,"iso_int":true}));

    // device isolate
    this.plugin.processApcBlockFlowMessage(JSON.stringify({
        "action":"block","pid":2415919104,"src":"192.168.77.124","dst":"192.168.77.189","sport":50261,
        "dport":80,"smac":"30:D5:3E:CF:F8:76","dmac":"88:E9:FE:86:FF:94",
        "ct":1,"ts":Date.now()/1000,"proto":"tcp","iso_lvl":1}));

    // ssid isolate
    this.plugin.processApcBlockFlowMessage(JSON.stringify({
        "action":"block","pid":2684354560,"src":"192.168.242.124","dst":"192.168.242.79","sport":50909,
        "dport":59585,"smac":"30:D5:3E:CF:F8:76","dmac":"CC:08:FA:61:CC:8B",
        "ct":1,"ts":Date.now()/1000,"proto":"tcp","iso_lvl":2}
    ));
  });

});
