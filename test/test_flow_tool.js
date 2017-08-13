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

let redis = require('redis');
let rclient = redis.createClient();

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let sample = require('./sample_data');

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let flowTool = require('../net2/FlowTool')();

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

describe('FlowTool', () => {

  let flow = {ts: new Date() / 1000};

  describe('.addFlow', () => {
    it('flow should exist if flow is added', (done) => {
      async(() => {
        await(flowTool.addFlow("10.0.1.1", "in", flow))
        let result = await(flowTool.flowExists("10.0.1.1", "in", flow));
        expect(result).to.be.true;
        done();
      })();
    })
  });

  describe('.removeFlow', () => {
    it('flow should NOT exist if flow is removed', (done) => {
      async(() => {
        let removeResult = await(flowTool.removeFlow("10.0.1.1", "in", flow));
        let result = await(flowTool.flowExists("10.0.1.1", "in", flow));
        expect(result).to.be.false;
        done();
      })();
    })
  });

  describe('.getRecentOutgoingConnections', () => {
    beforeEach((done) => {
      async(() => {
        await (sample.createSampleFlows());
        await (sample.addSampleIntelInfo());
        done();
      })();

    })

    afterEach((done) => {
      async(() => {
        await (sample.removeSampleFlows());
        await (sample.removeSampleIntelInfo());
        done();
      })();
    })

    it('should list recent outgoing flows correctly', (done) => {
      async(() => {
        let flows = await (flowTool.getRecentOutgoingConnections(sample.hostIP));
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
      async(() => {
        await (sample.createSampleFlows());
        await (sample.addSampleIntelInfo());
        done();
      })();

    })

    afterEach((done) => {
      async(() => {
        await (sample.removeSampleFlows());
        await (sample.removeSampleIntelInfo());
        done();
      })();
    })

    it('should list recent incoming flows correctly', (done) => {
      async(() => {
        let flows = await (flowTool.getRecentIncomingConnections(sample.hostIP));
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
      async(() => {
        await (sample.createSampleHost());
        await (sample.createSampleFlows());
        await (sample.addSampleIntelInfo());
        done();
      })();

    })

    afterEach((done) => {
      async(() => {
        await (sample.removeSampleFlows());
        await (sample.removeSampleIntelInfo());
        await (sample.removeSampleHost());
        done();
      })();
    })

    it('should list recent incoming flows correctly', (done) => {
      async(() => {
        let flows = await (flowTool.getAllRecentOutgoingConnections());
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
