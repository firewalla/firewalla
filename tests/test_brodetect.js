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

const bro = require("../net2/BroDetect.js");
const conntrack = require('../net2/Conntrack.js');
const execAsync = require('child-process-promise').exec;
const fireRouter = require('../net2/FireRouter.js')
const sysManager = require('../net2/SysManager.js');

describe.skip('test process conn data', function(){
  this.timeout(3000);

  beforeEach((done) => (
    async() => {
        fireRouter.scheduleReload();
        await new Promise(resolve => setTimeout(resolve, 2000));
        await sysManager.updateAsync();
        done();
    })()
  );

  afterEach((done) => {
    // source port 9999 for test
    done();
  });

  it('should validate conn data', (done) => {
    const data = {"ts":1710209544.631895,"uid":"CTPhHjfLC1DepnDF3","id.orig_h":"192.168.1.201","id.orig_p":57985,"id.resp_h":"44.242.60.85","id.resp_p":80,"proto":"tcp","service":"http","duration":0.34476304054260254,"orig_bytes":79,"resp_bytes":674,"conn_state":"SF","local_orig":true,"local_resp":false,"missed_bytes":0,"history":"ShADadFf","orig_pkts":6,"orig_ip_bytes":403,"resp_pkts":4,"resp_ip_bytes":890,"orig_l2_addr":"68:da:73:ac:ff:ff","resp_l2_addr":"20:6d:31:01:bb:bb"};
    const valid = bro.validateConnData(data, false);
    expect(valid).to.equal(true);
    done();
  });


  it('should processConnData', async() => {
    const intf = sysManager.getInterface("eth0");
    const data = `{"ts":1710209544.631895,"uid":"CTPhHjfLC1DepnDF3","id.orig_h":"${intf.ip_address}","id.orig_p":57985,"id.resp_h":"44.242.60.85","id.resp_p":80,"proto":"tcp","service":"http","duration":0.34476304054260254,"orig_bytes":79,"resp_bytes":674,"conn_state":"SF","local_orig":true,"local_resp":false,"missed_bytes":0,"history":"ShADadFf","orig_pkts":6,"orig_ip_bytes":403,"resp_pkts":4,"resp_ip_bytes":890,"orig_l2_addr":"${intf.mac_address}","resp_l2_addr":"20:6d:31:01:2b:40"}`;
    intf.uuid = "fake"
    sysManager.ipIntfCache.set(intf.ip_address, intf)
    await conntrack.setConnEntries(intf.ip_address, 57985, "44.242.60.85", "80", "tcp", {host:"fake", apid: 88, rpid: 99, proto: 'ssl', ip: '8.8.8.1'}, 600);
    await bro.processConnData(data, false);

    const result = await execAsync(`redis-cli zrevrange flow:conn:in:${intf.mac_address.toUpperCase()} 0 0`);
    const flows = result.stdout.trim();
    expect(JSON.parse(flows).apid).to.equal(88);
    expect(JSON.parse(flows).rpid).to.equal(99);
  });

  it('should processConnData w/o conn info', async() => {
    const intf = sysManager.getInterface("eth0");
    const data = `{"ts":1710209544.631895,"uid":"CTPhHjfLC1DepnDF3","id.orig_h":"${intf.ip_address}","id.orig_p":57900,"id.resp_h":"44.242.88.88","id.resp_p":8890,"proto":"tcp","service":"http","duration":0.34476304054260254,"orig_bytes":79,"resp_bytes":674,"conn_state":"SF","local_orig":true,"local_resp":false,"missed_bytes":0,"history":"ShADadFf","orig_pkts":6,"orig_ip_bytes":403,"resp_pkts":4,"resp_ip_bytes":890,"orig_l2_addr":"${intf.mac_address}","resp_l2_addr":"20:6d:31:01:2b:40"}`;
    intf.uuid = "fake"
    sysManager.ipIntfCache.set(intf.ip_address, intf)
    await bro.processConnData(data, false);

    const result = await execAsync(`redis-cli zrevrange flow:conn:in:${intf.mac_address.toUpperCase()} 0 0`);
    const flows = result.stdout.trim();
    expect(JSON.parse(flows).dh).to.equal('44.242.88.88');
    expect(JSON.parse(flows).apid).to.be.undefined;
    expect(JSON.parse(flows).rpid).to.be.undefined;
  });

});
