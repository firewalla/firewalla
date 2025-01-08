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

const log = require('../net2/logger.js')(__filename);
let bro, conntrack
const execAsync = require('child-process-promise').exec;
const fireRouter = require('../net2/FireRouter.js')
const sysManager = require('../net2/SysManager.js');
const { delay } = require('../util/util.js')
const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()
const DNSTool = require('../net2/DNSTool.js')
const dnsTool = new DNSTool()
const rclient = require('../util/redis_manager.js').getRedisClient();
const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();
const DomainTrie = require('../util/DomainTrie.js');

describe('test process conn data', function(){
  this.timeout(35000);

  before(async() => {
    process.title = "FireMain";

    bro = require("../net2/BroDetect.js");
    conntrack = require('../net2/Conntrack.js');
    categoryUpdater.domainPatternTrie = new DomainTrie();
    categoryUpdater.categoryWithPattern = new Set();

    await fireRouter.waitTillReady()
    await sysManager.updateAsync();
  })

  afterEach(() => {
    // source port 9999 for test
  });

  it('should validate conn data', async () => {
    const data = {"ts":1710209544.631895,"uid":"CTPhHjfLC1DepnDF3","id.orig_h":"192.168.1.201","id.orig_p":57985,"id.resp_h":"44.242.60.85","id.resp_p":80,"proto":"tcp","service":"http","duration":0.34476304054260254,"orig_bytes":79,"resp_bytes":674,"conn_state":"SF","local_orig":true,"local_resp":false,"missed_bytes":0,"history":"ShADadFf","orig_pkts":6,"orig_ip_bytes":403,"resp_pkts":4,"resp_ip_bytes":890,"orig_l2_addr":"68:da:73:ac:ff:ff","resp_l2_addr":"20:6d:31:01:bb:bb"};
    const valid = await bro.validateConnData(data);
    expect(valid).to.equal(true);
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

  it('extractIP should currectly parse IP string', async() => {
    expect(bro.extractIP('fe80::')).to.equal('fe80::')
    expect(bro.extractIP('[fe80::]')).to.equal('fe80::')
    expect(bro.extractIP('[fe80::]:123')).to.equal('fe80::')
    expect(bro.extractIP('192.168.0.1:123')).to.equal('192.168.0.1')
  });

  it('processHttpData should remove domain info on http connect', async() => {
    const data = '{"ts":1728719301,"uid":"COBkiT1UEOCvOOKzn6","id.orig_h":"192.168.1.100","id.orig_p":50000,"id.resp_h":"192.168.2.1","id.resp_p":8888,"trans_depth":1,"method":"CONNECT","host":"www.random.org","uri":"www.random.org:443","version":"1.1","user_agent":"curl/8.10.1","request_body_len":0,"response_body_len":0,"status_code":200,"status_msg":"OK","tags":[],"proxied":["PROXY-CONNECTION -> Keep-Alive"]}'
    const ip = '192.168.2.1'
    const host = 'www.random.org'

    await conntrack.setConnEntries('192.168.1.100', 50000, '192.168.2.1', 8888, 'tcp', {host:'unit.test'});
    await rclient.hmsetAsync(intelTool.getSSLCertKey(ip), {host:'unit.test'})
    await intelTool.addIntel(ip, {host, sslHost:host, dnsHost:host, category: 'ut'})
    await dnsTool.addDns(ip, host)
    await dnsTool.addReverseDns(host, [ip])

    await bro.processHttpData(data, false);

    expect(await conntrack.getConnEntries('192.168.1.100', 50000, '192.168.2.1', 8888, 'tcp')).to.not.exist
    expect(await rclient.hgetallAsync(intelTool.getSSLCertKey(ip))).to.not.exist
    expect(await dnsTool.getDns(ip)).to.not.exist
    expect(await dnsTool.getIPsByDomain(host)).to.be.an('array').that.not.include(ip)
    const intel = await intelTool.getIntel(ip)
    expect(intel.host).to.not.exist
    expect(intel.sslHost).to.not.exist
    expect(intel.dnsHost).to.not.exist
    expect(intel.category).to.not.exist
  });
});
