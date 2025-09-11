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
  before( async() => {
    await fireRouter.waitTillReady()
    await sysManager.updateAsync()
    await networkProfileManager.updatePrefixMap()
  })

  it('should assign apid/rpid', () => {
    const flow = {ts:1710300917.62,ets:1710300947.06,"_ts":1710300977.65034,sh:"192.168.196.105",dh:"140.82.113.25",ob:29,rb:25,ct:1,fd:"in",lh:"192.168.196.105",intf:"75da8a81-4881-4fcd-964f-7cb935355acc",du:29.44,
      af:{"alive.github.com":{"proto":"ssl","ip":"140.82.113.25"}},pr:"tcp",uids:["CVisnh3UdTVurR370j"],ltype:"mac",userTags:["1"],tags:["2"],sp:[51899],dp:443, dpid:77,apid:88,rpid:99};
    const formatted = flowTool.toSimpleFormat(flow);
    expect(formatted.apid).to.equal(77);
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
});
