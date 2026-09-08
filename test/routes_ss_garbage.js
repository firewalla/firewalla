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
 * Tests for GET /ss/garbage (api/routes/ss.js), the unauthenticated speed-test
 * download endpoint on port 8833.
 *
 * The ckSize query parameter is the bound of a synchronous loop that writes one
 * 1MiB chunk per iteration. It used to be taken from the query with no check, so
 * ckSize=Infinity looped forever and blocked the FireApi event loop, and large
 * finite values blocked it for a long time. These tests pin the input handling
 * and the two properties that keep the endpoint cheap.
 *
 * The route pulls in only express, path and body-parser, so this suite needs no
 * redis and no box state.
 *
 * Run: NODE_ENV=test mocha --exit test/test_ss_garbage.js
 */

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const chai = require('chai');
const expect = chai.expect;

const CHUNK = 1048576;      // bytes the handler writes per iteration
const CAP = 1024;           // chunks the handler accepts at most
const FALLBACK = 100;       // chunks used when ckSize is absent or unusable

// Per-request observations, keyed by the tid query parameter the tests pass.
const writes = {};          // number of res.write calls
const loopMs = {};          // duration of the handler's synchronous write loop
const queued = {};          // socket.writableLength once the loop is done

function get(query) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: `/ss/garbage?${query}` }, res => {
      let bytes = 0;
      res.on('data', d => { bytes += d.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes }));
    }).on('error', reject);
  });
}

// Request over a raw socket that never reads the response, so the handler runs
// against a socket that refuses every chunk. The socket is returned so the test
// can destroy it.
function getWithoutReading(query) {
  const sock = net.connect(server.address().port, '127.0.0.1', () => {
    sock.write(`GET /ss/garbage?${query} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    sock.pause();
  });
  sock.on('error', () => {});
  return sock;
}

async function waitFor(done, timeout) {
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the handler to finish');
    await new Promise(r => setTimeout(r, 20));
  }
}

// A handler whose write loop does not terminate blocks its own event loop, so it
// can neither report a count nor be timed out from inside the process. Requests
// with such a ckSize are therefore issued from a child process, which counts the
// writes the same way and is killed if it never gets there.
const CHILD = `
  const express = require(process.env.SS_EXPRESS);
  const http = require('http');
  const app = express();
  app.use('/ss', function (req, res, next) {
    var n = 0;
    var end = res.end.bind(res);
    res.write = function () { n++; return false; };
    res.end = function () { process.stdout.write('CHUNKS=' + n + '\\n'); return end(); };
    next();
  });
  app.use('/ss', require(process.env.SS_ROUTE));
  var server = app.listen(0, '127.0.0.1', function () {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/ss/garbage?' + process.env.SS_QUERY }, function (res) {
      res.resume();
      res.on('end', function () { process.exit(0); });
    });
  });
`;

function chunksInChild(query, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD], {
      env: Object.assign({}, process.env, {
        SS_EXPRESS: require.resolve('express'),
        SS_ROUTE: path.join(__dirname, '..', 'api', 'routes', 'ss.js'),
        SS_QUERY: query,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`handler did not finish within ${timeout}ms for ${query}, its write loop is unbounded`));
    }, timeout);
    child.on('exit', () => {
      clearTimeout(timer);
      const m = out.match(/CHUNKS=(\d+)/);
      if (!m) return reject(new Error(`no chunk count from the child for ${query}: ${err || out}`));
      resolve(Number(m[1]));
    });
  });
}

let server;
const rawSockets = [];

describe('GET /ss/garbage', function () {

  before(function (done) {
    const app = express();
    // Observe the handler: count its writes, time its synchronous loop, and read
    // back how much it left queued on the socket. A request carrying stub=1 also
    // has its writes swallowed, so a chunk count can be asserted without moving
    // the payload; returning false there mirrors the real socket, which refuses
    // every 1MiB chunk.
    app.use('/ss', function (req, res, next) {
      const tid = req.query.tid;
      const stub = req.query.stub === '1';
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      const t0 = process.hrtime();
      let n = 0;
      res.write = function (chunk) {
        n++;
        return stub ? false : write(chunk);
      };
      res.end = function (...args) {
        const d = process.hrtime(t0);
        if (tid) {
          writes[tid] = n;
          queued[tid] = res.socket ? res.socket.writableLength : 0;
          loopMs[tid] = d[0] * 1000 + d[1] / 1e6;
        }
        return end(...args);
      };
      next();
    });
    app.use('/ss', require('../api/routes/ss.js'));
    server = app.listen(0, '127.0.0.1', done);
  });

  after(function (done) {
    rawSockets.forEach(s => s.destroy());
    server.close(done);
  });

  describe('ckSize bound', function () {
    // Every hostile or unusable value has to land on the fallback, and every
    // oversized one on the cap. These values all terminate the loop even with
    // the old code, so they can be checked in this process; the values that do
    // not are covered by the child-process suite below.
    const cases = [
      { name: 'absent',                 query: '',                    chunks: FALLBACK },
      { name: '-Infinity',              query: 'ckSize=-Infinity',    chunks: FALLBACK },
      { name: 'NaN',                    query: 'ckSize=NaN',          chunks: FALLBACK },
      { name: 'non-numeric',            query: 'ckSize=abc',          chunks: FALLBACK },
      { name: 'empty',                  query: 'ckSize=',             chunks: FALLBACK },
      { name: 'negative',               query: 'ckSize=-1',           chunks: FALLBACK },
      { name: 'zero',                   query: 'ckSize=0',            chunks: FALLBACK },
      { name: 'fractional',             query: 'ckSize=1.5',          chunks: FALLBACK },
      { name: 'repeated (array)',       query: 'ckSize=1&ckSize=2',   chunks: FALLBACK },
      { name: 'hex-looking',            query: 'ckSize=0x400',        chunks: CAP },
      { name: 'one above the cap',      query: 'ckSize=1025',         chunks: CAP },
      { name: 'at the cap',             query: 'ckSize=1024',         chunks: CAP },
      { name: 'below the cap',          query: 'ckSize=7',            chunks: 7 },
    ];

    cases.forEach((c, i) => {
      it(`serves ${c.chunks} chunks for ckSize ${c.name}`, async () => {
        const tid = `bound${i}`;
        const res = await get(`tid=${tid}&stub=1${c.query ? '&' + c.query : ''}`);
        expect(res.status).to.equal(200);
        expect(writes[tid]).to.equal(c.chunks);
      });
    });

    it('accepts the chunk size the shipped web client asks for', async () => {
      const worker = await fs.promises.readFile(
        path.join(__dirname, '..', 'api', 'public', 'ss', 'speedtest_worker.js'), 'utf8');
      const m = worker.match(/garbagePhp_chunkSize:\s*(\d+)/);
      expect(m, 'garbagePhp_chunkSize not found in speedtest_worker.js').to.not.equal(null);
      const clientChunks = Number(m[1]);
      expect(clientChunks).to.be.at.most(CAP);

      const res = await get(`tid=client&stub=1&ckSize=${clientChunks}`);
      expect(res.status).to.equal(200);
      expect(writes['client']).to.equal(clientChunks);
    });
  });

  describe('unbounded ckSize', function () {
    // The original defect: with the bound taken straight from the query,
    // ckSize=Infinity never leaves the loop and a string such as 1e9 coerces to
    // a bound the box cannot reach in any useful time. Both wedge FireApi, so
    // these run out of process and a wedged handler fails here rather than
    // hanging the suite.
    const cases = [
      { name: 'Infinity',    query: 'ckSize=Infinity',              chunks: FALLBACK },
      { name: '1e9',         query: 'ckSize=1e9',                   chunks: CAP },
      { name: 'beyond 2^53', query: 'ckSize=99999999999999999999',  chunks: CAP },
    ];

    cases.forEach(c => {
      it(`terminates and serves ${c.chunks} chunks for ckSize ${c.name}`, async function () {
        this.timeout(30000);
        expect(await chunksInChild(c.query, 10000)).to.equal(c.chunks);
      });
    });
  });

  describe('cost of one request', function () {
    it('sends exactly 100MiB when ckSize is absent', async function () {
      this.timeout(60000);
      const res = await get('tid=payload');
      expect(res.status).to.equal(200);
      expect(res.bytes).to.equal(FALLBACK * CHUNK);
    });

    it('finishes its synchronous loop at the cap without blocking the event loop', async function () {
      this.timeout(30000);
      // A client that never reads is the worst case: every write is refused and
      // queues. The loop is synchronous, so its duration is exactly how long the
      // FireApi event loop is blocked. Measured at 1-18ms on a box; the old code
      // never left this loop for ckSize=Infinity.
      const sock = getWithoutReading('tid=noblock&ckSize=1024');
      rawSockets.push(sock);
      await waitFor(() => loopMs['noblock'] !== undefined, 20000);
      expect(writes['noblock']).to.equal(CAP);
      expect(loopMs['noblock']).to.be.below(500);
      sock.destroy();
    });
  });

  describe('cost of many unread requests', function () {
    it('does not turn queued chunks into retained memory', async function () {
      this.timeout(60000);
      // All iterations write the same cached buffer, so the socket queue holds
      // references rather than copies: 1GiB nominally queued per connection costs
      // roughly 0.4MiB of bookkeeping. This guards the property, not the exact
      // number -- writing a fresh or copied buffer per chunk would make these 50
      // connections retain 50GiB and take the process down.
      const n = 50;
      const rssBefore = process.memoryUsage().rss;
      for (let i = 0; i < n; i++) {
        rawSockets.push(getWithoutReading(`tid=mem${i}&ckSize=1024`));
      }
      await waitFor(() => {
        for (let i = 0; i < n; i++) if (loopMs[`mem${i}`] === undefined) return false;
        return true;
      }, 40000);

      for (let i = 0; i < n; i++) {
        expect(writes[`mem${i}`], `connection ${i} chunk count`).to.equal(CAP);
        // the whole response really is sitting in the socket queue, unsent
        expect(queued[`mem${i}`], `connection ${i} queued bytes`).to.be.at.least(CAP * CHUNK);
      }
      const grownMiB = (process.memoryUsage().rss - rssBefore) / CHUNK;
      expect(grownMiB, `rss grew ${grownMiB.toFixed(0)}MiB for ${n} unread 1GiB responses`).to.be.below(200);

      rawSockets.forEach(s => s.destroy());
      rawSockets.length = 0;
    });
  });
});
