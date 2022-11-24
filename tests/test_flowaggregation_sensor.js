/*    Copyright 2016-2021 Firewalla Inc.
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
      (async() =>{
        // just make sure all data in test db is cleaned up
        await sample.removeSampleHost();
        await sample.removeSampleFlows();
        await sample.createSampleHost();
        await sample.createSampleFlows();
        done();
      })();
    });

    afterEach((done) => {
      (async() =>{
        await sample.removeSampleHost();
        await sample.removeSampleFlows();
        done();
      })();
    });

    after((done) => {
      (async() =>{
        await sample.removeAllSampleAggrFlows();
        done();
      })();
    });

    it('should aggregate multiple flows together', (done) => {
      (async() =>{
        await flowAggrSensor.aggr(sample.hostMac, getIntervalEnd(sample.ts));
        let result = await flowAggrTool.flowExists(sample.hostMac, "download", "600", getIntervalEnd(sample.ts));
        expect(result).to.be.true;

        let result2 = await flowAggrTool.flowExists(sample.hostMac, "upload", "600", getIntervalEnd(sample.ts));
        expect(result2).to.be.true;

        let uploadTraffic = await flowAggrTool.getFlowTrafficByDestIP(sample.hostMac, "upload", "600", getIntervalEnd(sample.ts), sample.destIP);
        expect(uploadTraffic).to.equal('200');

        let downloadTraffic = await flowAggrTool.getFlowTrafficByDestIP(sample.hostMac, "download", "600", getIntervalEnd(sample.ts), sample.destIP);
        expect(downloadTraffic).to.equal('400');

        let key = flowAggrTool.getFlowKey(sample.hostMac, "upload", "600", getIntervalEnd(sample.ts));
        let ttl = await rclient.ttlAsync(key);
        expect(ttl).to.be.below(48 * 3600 + 1);
        done();
      })();
    })
  })

  describe('.aggrActivity', () => {
    beforeEach((done) => {
      (async() =>{
        // just make sure all data in test db is cleaned up
        await sample.removeSampleHost();
        await sample.removeSampleFlows();
        await sample.createSampleHost();
        await sample.createSampleFlows();
        await sample.addSampleIntelInfo();
        done();
      })();
    });

    afterEach((done) => {
      (async() =>{
        await sample.removeSampleHost();
        await sample.removeSampleFlows();
        await sample.removeSampleIntelInfo();
        done();
      })();
    });

    after((done) => {
      (async() =>{
        await sample.removeAllSampleAggrFlows();
        done();
      })();
    });

    it('should aggregate multiple flows together', (done) => {
      (async() =>{
        await flowAggrSensor.aggrActivity(sample.hostMac, getIntervalEnd(sample.ts));
        let result = await flowAggrTool.flowExists(sample.hostMac, "app", "600", getIntervalEnd(sample.ts));
        expect(result).to.be.true;

        let appKey = flowAggrTool.getFlowKey(mac, "app", '600', getIntervalEnd(sample.ts));
        let traffic = await rclient.zscoreAsync(appKeykey, JSON.stringify({device:mac, app: 'search'}));
        expect(traffic).to.equal('300');

        let key = flowAggrTool.getFlowKey(sample.hostMac, "app", "600", getIntervalEnd(sample.ts));
        let ttl = await rclient.ttlAsync(key);
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

  describe('.trafficGroupByApp', () => {
    beforeEach((done) => {
      (async() =>{
        await sample.addSampleIntelInfo();
        done()
      })();
    });

    afterEach((done) => {
      (async() =>{
        await sample.removeSampleIntelInfo();
        done()
      })();
    });

    it('should correctly group traffic by app', (done) => {
      (async() =>{
        let flows = [sample.sampleFlow1, sample.sampleFlow2];
        let traffic = await flowAggrSensor.trafficGroupByApp(flows);
        let keys = Object.keys(traffic);
        expect(keys.length).to.equal(1);
        expect(keys[0]).to.equal('search');
        expect(traffic['search']['duration']).to.equal(300);
        done();
      })();
    })
  })

  describe('._flowHasActivity', () => {
    beforeEach((done) => {
      (async() =>{
        await sample.addSampleIntelInfo();
        done()
      })();
    });

    afterEach((done) => {
      (async() =>{
        await sample.removeSampleIntelInfo();
        done()
      })();
    });

    it('should check if any flow has activity', (done) => {
      let flow = sample.sampleFlow1;
      let cache = {};
      let result = await flowAggrSensor._flowHasActivity(flow, cache);
      expect(result).to.equal(true);
      expect(cache[sample.destIP]).to.equal(1);
      let flow2 = JSON.parse(JSON.stringify(flow));
      flow2.dh = '8.9.9.9';
      let result2 = await flowAggrSensor._flowHasActivity(flow2, cache);
      expect(result2).to.equal(false);
      expect(cache['8.9.9.9']).to.equal(0);
      done();
    })
  })

});
