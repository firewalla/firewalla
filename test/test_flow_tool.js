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

const chai = require('chai');
const expect = chai.expect;

const fireRouter = require('../net2/FireRouter.js')
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const sysManager = require('../net2/SysManager.js');
const flowTool = require('../net2/FlowTool');
const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();
const DestIPFoundHook = require('../hook/DestIPFoundHook');

let sample = require('./sample_data');

// Need to modify after refactor
describe.skip('FlowTool', () => {

  let flow = {ts: new Date() / 1000};

  describe('.addFlow', () => {
    it('flow should exist if flow is added', (done) => {
      (async() =>{
        await flowTool.addFlow("10.0.1.1", "in", flow)
        let result = await flowTool.flowExists("10.0.1.1", "in", flow);
        expect(result).to.be.true;
        done();
      })();
    })
  });

  describe('.removeFlow', () => {
    it('flow should NOT exist if flow is removed', (done) => {
      (async() =>{
        let removeResult = await flowTool.removeFlow("10.0.1.1", "in", flow);
        let result = await flowTool.flowExists("10.0.1.1", "in", flow);
        expect(result).to.be.false;
        done();
      })();
    })
  });

  describe('.getRecentOutgoingConnections', () => {
    beforeEach((done) => {
      (async() =>{
        await sample.createSampleFlows();
        await sample.addSampleIntelInfo();
        done();
      })();

    })

    afterEach((done) => {
      (async() =>{
        await sample.removeSampleFlows();
        await sample.removeSampleIntelInfo();
        done();
      })();
    })

    it('should list recent outgoing flows correctly', (done) => {
      (async() =>{
        let flows = await flowTool.getRecentOutgoingConnections(sample.hostIP);
        expect(flows.length).to.equal(1);
        let flow = flows[0];
        expect(flow.ip).to.equal(sample.destIP);
        expect(flow.country).to.equal('US');
        expect(flow.host).to.equal('www.google.com');
        done();
      })();

    })
  })

  describe('._mergeFlows', () => {
    it('should merge flow correctly', (done) => {

      // A clone of existing flow obj is required so that it won't
      // change the original flow obj
      // Changing original flow obj may impact other testcases.
      let flows = [JSON.parse(JSON.stringify(sample.sampleFlow1)),
        JSON.parse(JSON.stringify(sample.sampleFlow2))];
      let mergedFlows = flowTool._mergeFlows(flows);
      expect(mergedFlows.length).to.equal(1);
      expect(mergedFlows[0].dh).to.equal(sample.destIP);
      done();
    })
  })

  describe('.getRecentIncomingConnections', () => {
    beforeEach((done) => {
      (async() =>{
        await sample.createSampleFlows();
        await sample.addSampleIntelInfo();
        done();
      })();

    })

    afterEach((done) => {
      (async() =>{
        await sample.removeSampleFlows();
        await sample.removeSampleIntelInfo();
        done();
      })();
    })

    it('should list recent incoming flows correctly', (done) => {
      (async() =>{
        let flows = await flowTool.getRecentIncomingConnections(sample.hostIP);
        expect(flows.length).to.equal(1);
        let flow = flows[0];
        expect(flow.ip).to.equal(sample.destIP2);
        expect(flow.country).to.equal('US');
        expect(flow.host).to.equal('www.google.com');
        done();
      })();

    })
  })

  describe('.getAllRecentOutgoingConnections', () => {
    beforeEach((done) => {
      (async() =>{
        await sample.createSampleHost();
        await sample.createSampleFlows();
        await sample.addSampleIntelInfo();
        done();
      })();

    })

    afterEach((done) => {
      (async() =>{
        await sample.removeSampleFlows();
        await sample.removeSampleIntelInfo();
        await sample.removeSampleHost();
        done();
      })();
    })

    it('should list recent incoming flows correctly', (done) => {
      (async() =>{
        let flows = await flowTool.getAllRecentOutgoingConnections();
        expect(flows.length).to.equal(1);
        let flow = flows[0];
        expect(flow.ip).to.equal(sample.destIP);
        expect(flow.country).to.equal('US');
        expect(flow.host).to.equal('www.google.com');
        done();
      })();

    })
  })
});


describe('should format simple format', function() {
  this.timeout(10000);

  before( async() => {
    await fireRouter.waitTillReady()
    await sysManager.updateAsync()
    await networkProfileManager.updatePrefixMap()
  })

  it('should assign apid/rpid', () => {
    const flow = {ts:1710300917.62,ets:1710300947.06,"_ts":1710300977.65034,sh:"192.168.196.105",dh:"140.82.113.25",ob:29,rb:25,ct:1,fd:"in",lh:"192.168.196.105",intf:"75da8a81-4881-4fcd-964f-7cb935355acc",du:29.44,
      af:{"alive.github.com":{"proto":"ssl","ip":"140.82.113.25"}},pr:"tcp",uids:["CVisnh3UdTVurR370j"],ltype:"mac",userTags:["1"],tags:["2"],sp:[51899],dp:443, dpid:77,apid:88,rpid:99};
    const formatted = flowTool.toSimpleFormat(flow);
    expect(formatted.dpid).to.equal(77);
    expect(formatted.apid).to.equal(88);
    expect(formatted.rpid).to.equal(99);
  })

  it('should deal with both full and prefixed oIntf', () => {
    const fullID = sysManager.getDefaultWanInterface().uuid

    const flow = {ts:1710300917.62, sh:"192.168.1.1", dh:"192.168.2.1", ob:29,rb:25,ct:1,fd:"in", lh:"192.168.1.1", intf:"00000000-0000-0000-0000-000000000000", du:29,pr:"tcp", ltype:"mac", sp:[51000],dp:443};

    flow.oIntf = fullID
    expect(flowTool.toSimpleFormat(flow).oIntf).to.equal(fullID)

    flow.oIntf = fullID.substring(0, 8)
    expect(flowTool.toSimpleFormat(flow).oIntf).to.equal(fullID)
  })

  it('should decode the security category', async () => {
    const code = await intelTool.categoryToNumber('intel')
    const flow = {ts:1710300917.62, sh:"192.168.1.1", dh:"203.0.113.10", ob:29,rb:25,ct:1,fd:"in", lh:"192.168.1.1", intf:"00000000-0000-0000-0000-000000000000", du:29,pr:"tcp", ltype:"mac", sp:[51000],dp:443, c:code, cc:"phishing"};
    const formatted = flowTool.toSimpleFormat(flow)
    expect(formatted.category).to.equal('intel')
    expect(formatted.cc).to.equal('phishing')

    delete flow.cc
    expect(flowTool.toSimpleFormat(flow).cc).to.be.undefined
  })
});

describe('enrichWithIntel security category', function() {
  let getIntel, isInlineIntelReady, processIP, lookups, intel, refreshed

  // migrations listed here are past the flow retention window
  const ready = (...codeNames) => {
    intelTool.isInlineIntelReady = codeName => codeNames.includes(codeName || 'flow_inline_intel')
  }

  before(() => {
    getIntel = intelTool.getIntel
    isInlineIntelReady = intelTool.isInlineIntelReady
    processIP = DestIPFoundHook.prototype.processIP
    intelTool.getIntel = async () => {
      lookups++
      return intel
    }
    DestIPFoundHook.prototype.processIP = async ip => { refreshed.push(ip) }
  })

  beforeEach(() => {
    lookups = 0
    intel = {category: 'intel', cc: '["attackpage","malware"]', host: 'www.example.com'}
    refreshed = []
  })

  after(() => {
    intelTool.getIntel = getIntel
    intelTool.isInlineIntelReady = isInlineIntelReady
    DestIPFoundHook.prototype.processIP = processIP
  })

  it('should take the security category from the intel lookup', async () => {
    ready()
    const [ip, domain] = await flowTool.enrichWithIntel([
      {ip: '203.0.113.10', type: 'ip', appHosts: ['www.example.com']},
      {domain: 'www.example.com'},
    ])
    expect(ip.category).to.equal('intel')
    expect(ip.cc).to.equal('malware')
    expect(domain.category).to.equal('intel')
    expect(domain.cc).to.equal('malware')
  })

  it('should look up cc of an intel record written before the cc migration', async () => {
    ready('flow_inline_intel')
    const [ip, domain, baked, other, none] = await flowTool.enrichWithIntel([
      {ip: '203.0.113.10', type: 'ip', category: 'intel'},
      {domain: 'www.example.com', category: 'intel'},
      {ip: '203.0.113.11', type: 'ip', category: 'intel', cc: 'phishing'},
      {ip: '203.0.113.12', type: 'ip', category: 'porn'},
      {ip: '203.0.113.13', type: 'ip'},
    ])
    expect(ip.cc).to.equal('malware')
    expect(domain.cc).to.equal('malware')
    expect(baked.cc).to.equal('phishing')
    expect(other.cc).to.be.undefined
    expect(none.category).to.equal('intel')
    expect(none.cc).to.equal('malware')
    expect(lookups).to.equal(3)
  })

  it('should refresh intel from the cloud only for a record with no category', async () => {
    intel = undefined
    ready('flow_inline_intel')
    await flowTool.enrichWithIntel([
      {ip: '203.0.113.14', type: 'ip', category: 'intel'},
      {ip: '203.0.113.15', type: 'ip'},
    ])
    expect(lookups).to.equal(2)
    expect(refreshed).to.be.empty

    ready()
    await flowTool.enrichWithIntel([
      {ip: '203.0.113.14', type: 'ip', category: 'intel'},
      {ip: '203.0.113.15', type: 'ip'},
    ])
    expect(refreshed).to.deep.equal(['203.0.113.15'])
  })

  it('should not look up once the cc migration is past the retention window', async () => {
    ready('flow_inline_intel', 'flow_inline_intel_cc')
    const [f] = await flowTool.enrichWithIntel([
      {ip: '203.0.113.10', type: 'ip', category: 'intel'},
    ])
    expect(f.category).to.equal('intel')
    expect(f.cc).to.be.undefined
    expect(lookups).to.equal(0)
  })

  it('should drop the security category of an adblock record', async () => {
    ready('flow_inline_intel', 'flow_inline_intel_cc')
    const [f] = await flowTool.enrichWithIntel([
      {domain: 'www.example.com', category: 'intel', cc: 'phishing', reason: 'adblock'},
    ])
    expect(f.category).to.equal('ad')
    expect(f.cc).to.be.undefined
  })
});
