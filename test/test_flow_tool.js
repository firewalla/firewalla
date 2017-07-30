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

  describe('.getRecentOutgoingConnections', (done) => {
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

  describe('.getRecentIncomingConnections', (done) => {
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
});
