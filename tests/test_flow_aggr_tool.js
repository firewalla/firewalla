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

let FlowAggrTool = require('../net2/FlowAggrTool');
let flowAggrTool = new FlowAggrTool();

describe('FlowAggrTool', () => {

  let flow = {ts: new Date() / 1000};

  describe('.getIntervalTick', () => {
    it('the tick of 301 (with interval 30) should be 300', (done) => {
      expect(flowAggrTool.getIntervalTick(301, 30)).to.equal(300);
      done();
    })

    it('the tick of 301.3 (with interval 30) should be 300', (done) => {
      expect(flowAggrTool.getIntervalTick(301.3, 30)).to.equal(300);
      done();
    })

    it('the tick of 301.4 (with interval 30.3) should be 300', (done) => {
      expect(flowAggrTool.getIntervalTick(301.4, 30.3)).to.equal(300);
      done();
    })
  });

  describe('.getLargerIntervalTick', () => {
    it('the tick of 301 (with interval 30) should be 330', (done) => {
      expect(flowAggrTool.getLargerIntervalTick(301, 30)).to.equal(330);
      done();
    });

    it('the tick of 301.3 (with interval 30) should be 330', (done) => {
      expect(flowAggrTool.getLargerIntervalTick(301.3, 30)).to.equal(330);
      done();
    });

    it('the tick of 301.4 (with interval 30.3) should be 330', (done) => {
      expect(flowAggrTool.getLargerIntervalTick(301.4, 30.3)).to.equal(330);
      done();
    })

    it('the tick of 180 (with interval 70) should be 210', (done) => {
      expect(flowAggrTool.getLargerIntervalTick(180, 70)).to.equal(210);
      done();
    })
  });

  describe('.getTicks', () => {
    it('should have 5 ticks between 100 and 200 (with interval 20)', (done) => {
      // 100 should not be ticks as the range is open-interval.
      let ticks = flowAggrTool.getTicks(100, 200, 20);
      expect(ticks.length).to.equal(5);
      done();
    })
  });

  describe('.addSumFlow', () => {

    afterEach((done) => {
      async(() => {
        await (flowAggrTool.removeAllFlowKeys(sample.hostMac, "download", 600));
        await (flowAggrTool.removeAllSumFlows(sample.hostMac, "download"));
        done();
      })();
    });

    it('should be able to sum flows correctly', (done) => {
      let ts = flowAggrTool.toFloorInt(new Date() / 1000 - 24 * 3600);
      let begin = flowAggrTool.getIntervalTick(ts, 600);
      let end = flowAggrTool.getLargerIntervalTick(ts + 24* 3600, 600);

      async(() => {
        await (sample.createSampleAggrFlows());
        let result = await (
          flowAggrTool.addSumFlow("download", {
            begin: begin,
            end: end,
            interval: 600,
            mac: sample.hostMac
          })
        );
        expect(result).to.above(0);

        let traffic = await (flowAggrTool.getSumFlow(sample.hostMac, "download", begin, end, -1));
        expect(traffic.length).to.equal(2);
        expect(traffic[0]).to.equal(sample.destIP);
        expect(traffic[1]).to.equal("500");
        done();
      })();
    })
  });

  describe('.getLastSumFlow .setLastSumFlow', (done) => {
    it('should be able to get the same value that was set to database', (done) => {
      async(() => {
        let testData = "XXXXXXXXXXX";
        await (flowAggrTool.setLastSumFlow(sample.hostMac, "download", testData));
        let key = await (flowAggrTool.getLastSumFlow(sample.hostMac, "download"));
        expect(key).to.equal(testData);
        done();
      })();
    })
  });

});
