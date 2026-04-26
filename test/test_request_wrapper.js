/*    Copyright 2026 Firewalla Inc.
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
'use strict';
/**
 * Throttling tests for util/requestWrapper.js.
 * Run: npm test -- test/test_request_wrapper_throttling.js
 * (Requires npm install for chai/mocha.)
 */

const http = require('http');
const chai = require('chai');
const expect = chai.expect;

const log = require('../net2/logger.js')(__filename);
const loggerManager = require('../net2/LoggerManager.js');
const { rrWithErrHandling } = require('../util/requestWrapper.js');
const { delay } = require('../util/util.js')

describe('requestWrapper throttling', function () {
  let mockServer;
  let baseUrl;

  /** Create mock HTTP server: 200 by default, 429 if path ends with 'ratelimit'. Returns { server, port, baseUrl }. */
  before(async () => {
    // loggerManager.loggers.RequestWrapper.effectiveLogLevel = 'verbose';
    mockServer = http.createServer((req, res) => {
      const path = req.url || '';
      const statusCode = path.endsWith('ratelimit') ? 429 : 200;
      log.info(`Mock server: ${path} -> ${statusCode}`);
      res.writeHead(statusCode);
      res.end();
    });
    mockServer.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${mockServer.address().port}`;
    });
  });

  after((done) => {
    loggerManager.loggers.RequestWrapper.effectiveLogLevel = 'info';
    if (mockServer) mockServer.close(done);
  });

  describe('Test case 1: outbound throttle (10 in flight) and per-endpoint isolation', function () {
    this.timeout(70000);

    it('throttles after 10 requests to same endpoint; recovers after 1 min; endpoint2 unaffected', async () => {
      const endpoint1 = `${baseUrl}/endpoint1/`;
      const endpoint2 = `${baseUrl}/endpoint2/`;

      const runEndpoint1 = async () => {
        for (let i = 0; i < 22; i++) {
          await delay(3000);
          try {
            const res = await rrWithErrHandling({ uri: endpoint1 + i, maxAttempts: 1 });
            expect(i < 10 || i >= 20).to.be.true;
          } catch (e) {
            log.info(`/endpoint1/${i}: ${e.message}`);
            expect(i >= 10 && i < 20).to.be.true;
          }
        }
      };

      const runEndpoint2 = async () => {
        for (let i = 0; i < 6; i++) {
          await delay(10000);
          try {
            const res = await rrWithErrHandling({ uri: endpoint2 + i, maxAttempts: 1 });
          } catch (e) {
            expect.fail('All endpoint2 requests should succeed' + e.message);
          }
        }
      };

      await Promise.all([runEndpoint1(), runEndpoint2()]);
    });
  })

  describe('Test case 2: 429 backoff and per-endpoint isolation', function () {
    this.timeout(100000);

    it('429 triggers client-side throttle; backoff 10s then 60s; endpoint2 isolated', async () => {
      const base1 = `${baseUrl}/endpoint1`;
      const base2 = `${baseUrl}/endpoint2`;

      await Promise.all([
        (async () => {
          let res = await rrWithErrHandling({ uri: base1 + '/normal', maxAttempts: 1 });
          expect(res.statusCode).to.equal(200);

          let err429 = null
          try {
            await rrWithErrHandling({ uri: base1 + '/1st_ratelimit', maxAttempts: 1 });
          } catch (e) {
            log.info(`/1st_ratelimit: ${e}`);
            err429 = e;
          }
          expect(err429).to.not.be.null;
          expect(err429.statusCode).to.equal(429);

          for (let i = 0; i < 2; i++) {
            let throttled = false;
            try {
              await rrWithErrHandling({ uri: base1 + '/any', maxAttempts: 1 });
            } catch (e) {
              log.info(`/any: ${e}`);
              throttled = e.message && e.message.includes('Rate limited');
            }
            expect(throttled, 'within 10s all requests to endpoint1/ should be throttled').to.be.true;
          }

          await delay(10000);

          err429 = null;
          try {
            await rrWithErrHandling({ uri: base1 + '/2nd_ratelimit', maxAttempts: 1 });
          } catch (e) {
            err429 = e;
          }
          expect(err429).to.not.be.null;
          expect(err429.statusCode).to.equal(429);

          for (let i = 0; i < 2; i++) {
            let throttled = false;
            try {
              await rrWithErrHandling({ uri: base1 + '/any2', maxAttempts: 1 });
            } catch (e) {
              log.info(`/any2: ${e}`);
              throttled = e.message && e.message.includes('Rate limited');
            }
            expect(throttled, 'within next 60s all requests to endpoint1/ should be throttled').to.be.true;
          }

          await delay(60000);

          res = await rrWithErrHandling({ uri: base1 + '/normal', maxAttempts: 1 });
          expect(res.statusCode).to.equal(200);

          try {
            await rrWithErrHandling({ uri: base1 + '/3rd_ratelimit', maxAttempts: 1 });
          } catch (e) {
            expect(e.statusCode).to.equal(429);
          }


        })(),
        (async () => {
          for (let i = 0; i < 8; i++) {
            await rrWithErrHandling({ uri: base2 + '/anything', maxAttempts: 1 }).then(res => expect(res).to.be.ok).catch(e => expect(e).to.be.null);
            await delay(10000);
          }
        })(),
      ]);
    });
  });
})
