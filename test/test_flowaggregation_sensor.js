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

let FlowAggregationSensor = require('../sensor/FlowAggregationSensor');
let flowAggrSensor = new FlowAggregationSensor();

let FlowAggrTool = require('../net2/FlowAggrTool');
let flowAggrTool = new FlowAggrTool();

function toInt(n){ return Math.floor(Number(n)); };

function getIntervalEnd(ts) {
  return (1 + toInt(ts / 600)) * 600;
}

describe('Test Flow Aggregation Sensor', () => {


  describe('.aggr', () => {
    beforeEach((done) => {
      async(() =>
        // just make sure all data in test db is cleaned up
        await (sample.removeSampleHost());
        await (sample.removeSampleFlows());
        await (sample.createSampleHost());
        await (sample.createSampleFlows());
        done();
      })();
    });

    afterEach((done) => {
      async(() => {
        await (sample.removeSampleHost());
        await (sample.removeSampleFlows());
        done();
      })();
    });

    after((done) => {
      async(() => {
        await (sample.removeAllSampleAggrFlows());
        done();
      })();
    });

    it('should aggregate multiple flows together', (done) => {
      async(() => {
        await (flowAggrSensor.aggr(sample.hostMac, getIntervalEnd(sample.ts)));
        let result = await (flowAggrTool.flowExists(sample.hostMac, "download", "600", getIntervalEnd(sample.ts)));
        expect(result).to.be.true;

        let result2 = await (flowAggrTool.flowExists(sample.hostMac, "upload", "600", getIntervalEnd(sample.ts)));
        expect(result2).to.be.true;

        let uploadTraffic = await (flowAggrTool.getFlowTrafficByDestIP(sample.hostMac, "upload", "600", getIntervalEnd(sample.ts), sample.destIP));
        expect(uploadTraffic).to.equal('200');

        let downloadTraffic = await (flowAggrTool.getFlowTrafficByDestIP(sample.hostMac, "download", "600", getIntervalEnd(sample.ts), sample.destIP));
        expect(downloadTraffic).to.equal('400');

        let key = flowAggrTool.getFlowKey(sample.hostMac, "upload", "600", getIntervalEnd(sample.ts));
        let ttl = await (rclient.ttlAsync(key));
        expect(ttl).to.be.below(48 * 3600 + 1);
        done();
      })();
    })
  })

  describe('.trafficGroupByDestIP', () => {
    it('should correctly group traffic by destination ip addresses', (done) => {
      let flows = [sample.sampleFlow1, sample.sampleFlow2];
      let traffic = flowAggrSensor.trafficGroupByDestIP(flows);
      expect(Object.keys(traffic).length).to.equal(1);
      expect(traffic[sample.destIP]).to.not.equal(undefined);
      expect(traffic[sample.destIP].upload).to.equal(200);
      expect(traffic[sample.destIP].download).to.equal(400);
      done();
    })
  })

});
