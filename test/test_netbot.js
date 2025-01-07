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

process.title = "FireMain";
const execAsync = require('child-process-promise').exec;

const netBot = require("../controllers/netbot.js");
const cloud = require('../encipher');
const networkProfile = require('../net2/NetworkProfileManager.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const log = require('../net2/logger.js')(__filename);

describe.skip('test get flows', function(){
  this.timeout(3000);

  before(async() => {
    networkProfile.networkProfiles = {};
    networkProfile.networkProfiles["1f97bb38-7592-4be0-**"] = {ipv4:"192.168.203.134"};
    this.gid = "3d0a201e-0b2f-**";
    this.netbot = new netBot({name:"testbot", main:"netbot.js", controller:{type: "netbot", id:0}}, {service:"test", controllers:[]}, new cloud("netbot"), [], this.gid, true, true);
    this.appInfo = {
      deviceName: 'iPhone',
      appID: 'com.rottiesoft.circle',
      platform: 'ios',
      timezone: 'Asia/Shanghai',
      language: 'en',
      version: '1.60-71',
      eid: 'pWNKy3S6fKzDMdqV-b2t2A',
      ios: '17.3-1'
    };
  });

  after((done) => {
    // source port 9999 for test
    done();
  });


  it('should check log query args', async() => {
    const msg = {data:{item:"flows", atype: "tag", type: "tag", audit: true}, target: "av"};
    const options = await this.netbot.checkLogQueryArgs(msg);
    expect(options.tag).to.be.equal("av");
    expect(options.audit).to.be.equal(true);
  });

  it('should process get flows by interface', async() => {
    const msg = {data:{item:"flows", atype: "intf", type: "intf", count: 2}, target: "1f97bb38-7592-4be0-**"};

    const returnData = await this.netbot.getHandler(this.gid, msg, this.appInfo, {});
    expect(returnData.count).to.equal(0);
  });

  it('should process get flows by mac', async() => {
    const result = await execAsync("redis-cli keys 'flow:conn:in:*' | head -n 1 |  cut -d ':'  -f 4-9");
    const target = result.stdout.trim();

    const msg = {data:{item:"flows", count: 2}, target: target};
    const returnData = await this.netbot.getHandler(this.gid, msg, this.appInfo, {});
    expect(returnData.count).to.equal(2);
  });

  it('should process get audit by mac', async() => {
    // get available audit key
    const result = await execAsync("redis-cli keys 'audit:accept:*' | head -n 1 |  cut -d ':'  -f 3-8");
    const target = result.stdout.trim();

    const msg = {data:{item:"flows", audit:true, count: 2}, target: target};
    const returnData = await this.netbot.getHandler(this.gid, msg, this.appInfo, {});
    expect(returnData.count).to.equal(2);
  });

});

describe('test netbot', function(){
  before( async() => {
    this.gid = "3d0a201e-0b2f-**";
    this.netbot = new netBot({name:"testbot", main:"netbot.js", controller:{type: "netbot", id:0}}, {service:"test", controllers:[]}, new cloud("netbot"), [], this.gid, true, true);
    await rclient.saddAsync('sys:eid:blacklist', 'test-eid1');
  });

  it('should test eid acl', async() => {
    const rawmsg = {"mtype":"msg","message":{"type":"jsondata","appInfo":{"eid":"test-eid1"},"obj":{"mtype":"cmd","data":{},"type":"jsonmsg"}},"target":"1f97bb38-7592-4be0"};
    const response = await this.netbot.msgHandler(this.gid, rawmsg);
    log.debug("eid acl response", response);
  });

  it('should record msg data', async() => {
    await this.netbot._precedeRecord("FFFF056-5ECD-4F93-9201-AFFF7EC", {kkk: 111});
    const result = await rclient.getAsync("_hx:msg:FFFF056-5ECD-4F93-9201-AFFF7EC");
    expect(result).to.be.equal('{"kkk":111}');
  });
});
