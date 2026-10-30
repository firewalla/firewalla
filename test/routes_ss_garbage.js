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
// These mirror the constants in api/routes/ss.js; the handler paces by them.
const BATCH = 8;            // chunks written per event-loop turn before yielding
const LIMIT = 4 * 1048576;  // bytes allowed to queue on the socket before pausing
const MAX_GARBAGE = 8;      // concurrent downloads served before the rest get 503

// Advances once per event-loop turn while the suite runs, so a test can tell how
// many chunks a response wrote in a single synchronous turn (its burst).
let tick = 0;
let ticking = false;

// Per-request observations, keyed by the tid query parameter the tests pass.
const writes = {};          // number of res.write calls, recorded when the handler ends
const loopMs = {};          // duration of the handler's write loop
const queued = {};          // socket.writableLength once the loop is done
// A handler that honors backpressure parks on drain and never reaches res.end
// for a client that stops reading, so its write count and queue have to be read
// while it is still running. live[tid]() returns them on demand.
const live = {};

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
    // model an accepting socket (write() true) so the loop runs to the ckSize bound
    // and the count can be read; a non-terminating bound would still hang the child.
    res.write = function () { n++; return true; };
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
    // Model the async file-lookup window express.static opens ahead of this router in
    // the real app (api/app.js): a request carrying slow=1 is deferred, giving a test
    // time to disconnect before the garbage handler runs.
    app.use('/ss', function (req, res, next) {
      if (req.query.slow) return setTimeout(next, 100);
      next();
    });
    // Observe the handler: count its writes, time its loop, and read back how much
    // it left queued on the socket. A request carrying stub=1 has its writes
    // swallowed and reported as accepted (write() returns true), so the loop runs to
    // the ckSize bound and the chunk count can be asserted without moving the
    // payload. The real refusing socket -- where write() returns false and the loop
    // must park -- is exercised by the non-stub tests below.
    app.use('/ss', function (req, res, next) {
      const tid = req.query.tid;
      const stub = req.query.stub === '1';
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      const t0 = process.hrtime();
      let n = 0;
      let maxBurst = 0;
      const perTick = {};
      res.write = function (chunk) {
        n++;
        const b = (perTick[tick] || 0) + 1;
        perTick[tick] = b;
        if (b > maxBurst) maxBurst = b;
        return stub ? true : write(chunk);
      };
      if (tid) live[tid] = () => ({ writes: n, queued: res.socket ? res.socket.writableLength : 0, burst: maxBurst });
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
    ticking = true;
    (function hb() { if (!ticking) return; tick++; setImmediate(hb); })();
    server = app.listen(0, '127.0.0.1', done);
  });

  after(function (done) {
    ticking = false;
    rawSockets.forEach(s => s.destroy());
    server.close(done);
  });

  // The concurrency cap counts live downloads, so a test that holds connections open
  // must release them before the next test, and give the server a moment to free the
  // slots, or a later test starts with the cap already partly used.
  afterEach(async function () {
    rawSockets.forEach(s => s.destroy());
    rawSockets.length = 0;
    await new Promise(r => setTimeout(r, 1000));
  });

  // Open a download over a raw socket and resolve with its HTTP status (read from
  // the status line, not the body) and the socket, so a test can hold or drop it.
  function openStatus(query) {
    return new Promise(resolve => {
      const s = net.connect(server.address().port, '127.0.0.1', () => {
        s.write(`GET /ss/garbage?${query} HTTP/1.1\r\nHost: x\r\n\r\n`);
      });
      s.once('data', d => {
        const m = /^HTTP\/1\.1 (\d+)/.exec(d.toString());
        resolve({ status: m ? Number(m[1]) : 0, sock: s });
      });
      s.on('error', () => {});
      rawSockets.push(s);
    });
  }

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

    it('a client that stops reading parks with the socket queue bounded', async function () {
      this.timeout(30000);
      // A client that never reads is the worst case. The handler writes until the
      // socket holds LIMIT bytes, then parks, so the queue stays near LIMIT instead
      // of growing to the whole ~1GiB response -- and no turn writes more than BATCH.
      const sock = getWithoutReading('tid=park&ckSize=1024');
      rawSockets.push(sock);
      // Once parked, the socket queue stops changing; sample until it settles.
      let prev = -1;
      await waitFor(() => {
        const q = live['park'] ? live['park']().queued : 0;
        const settled = q === prev && q > 0;
        prev = q;
        return settled;
      }, 20000);
      const o = live['park']();
      expect(o.queued, 'parked socket queue').to.be.below(LIMIT + 16 * CHUNK);
      expect(o.burst, 'chunks written in one event-loop turn').to.be.at.most(BATCH);
      sock.destroy();
    });

    it('no response blocks the event loop when an unread client pipelines requests', async function () {
      this.timeout(30000);
      // Pipelining defeated the earlier fixes: with several hundred requests buffered
      // on one connection, Node resumes the active response synchronously while its
      // socket is backed up, re-entering the write loop until the whole response goes
      // out in one turn (observed as a burst of hundreds to ~1024). Pacing with
      // setImmediate bounds every response to BATCH chunks per turn regardless, and
      // the concurrency cap bounds how many respond at all. The request count has to
      // be large: a few dozen do not trigger the synchronous-resume amplification.
      const N = 300;
      const sock = net.connect(server.address().port, '127.0.0.1', () => {
        let buf = '';
        for (let i = 0; i < N; i++)
          buf += `GET /ss/garbage?tid=pipe${i}&ckSize=1024 HTTP/1.1\r\nHost: x\r\n\r\n`;
        sock.write(buf);
        sock.pause();
      });
      sock.on('error', () => {});
      rawSockets.push(sock);
      await new Promise(r => setTimeout(r, 2000));
      let maxBurst = 0, served = 0;
      for (let i = 0; i < N; i++) {
        if (!live[`pipe${i}`]) continue;
        const o = live[`pipe${i}`]();
        if (o.writes > 0) served++;
        if (o.burst > maxBurst) maxBurst = o.burst;
      }
      expect(maxBurst, 'a response wrote more than BATCH chunks in one event-loop turn').to.be.at.most(BATCH);
      expect(served, 'more responses ran than the concurrency cap allows').to.be.at.most(MAX_GARBAGE);
      sock.destroy();
    });

    it('stops writing when a reading client disconnects mid-download', async function () {
      this.timeout(30000);
      // A draining client lets the loop keep resuming, so it would run to the cap.
      // If the client disconnects partway, the close handler must stop it: the write
      // count has to freeze below the cap instead of climbing against a dead socket.
      const sock = net.connect(server.address().port, '127.0.0.1', () => {
        sock.write(`GET /ss/garbage?tid=close&ckSize=1024 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      sock.on('error', () => {});
      rawSockets.push(sock);
      // Read part of the response so the loop makes progress, then cut the link.
      let got = 0;
      await new Promise((resolve) => {
        sock.on('data', d => { got += d.length; if (got >= 8 * CHUNK) { sock.destroy(); resolve(); } });
      });
      // After the disconnect the write count must stop climbing.
      await new Promise(r => setTimeout(r, 300));
      const a = live['close'] ? live['close']().writes : 0;
      await new Promise(r => setTimeout(r, 300));
      const b = live['close']().writes;
      expect(b - a, 'writes kept climbing after the client left').to.be.at.most(2);
      expect(b, 'handler ran to the cap despite the disconnect').to.be.below(CAP);
    });
  });

  describe('cost of many unread requests', function () {
    it('keeps the socket queue and memory bounded across many unread connections', async function () {
      this.timeout(60000);
      // Below the concurrency cap, every unread connection parks with its socket
      // queue near LIMIT, so the per-connection queue and process RSS stay bounded
      // instead of growing with the nominal ~1GiB-per-response size.
      const n = 20;
      const rssBefore = process.memoryUsage().rss;
      for (let i = 0; i < n; i++) {
        rawSockets.push(getWithoutReading(`tid=mem${i}&ckSize=1024`));
      }
      // Give every connection time to reach its parked state.
      await new Promise(r => setTimeout(r, 2000));

      for (let i = 0; i < n; i++) {
        const o = live[`mem${i}`]();
        expect(o.queued, `connection ${i} socket queue`).to.be.below(LIMIT + 16 * CHUNK);
        expect(o.burst, `connection ${i} burst`).to.be.at.most(BATCH);
      }
      const grownMiB = (process.memoryUsage().rss - rssBefore) / CHUNK;
      expect(grownMiB, `rss grew ${grownMiB.toFixed(0)}MiB for ${n} unread responses`).to.be.below(200);
    });
  });

  describe('concurrency cap', function () {
    it('refuses downloads past the cap with 503', async function () {
      this.timeout(30000);
      // One client can open many connections or pipeline many requests. The cap
      // bounds how many responses buffer at once -- the aggregate, which per-response
      // backpressure cannot bound -- so the excess must be refused, not queued.
      const N = MAX_GARBAGE + 10;
      const statuses = [];
      for (let i = 0; i < N; i++) {
        const s = net.connect(server.address().port, '127.0.0.1', () => {
          s.write(`GET /ss/garbage?ckSize=1024 HTTP/1.1\r\nHost: x\r\n\r\n`);
        });
        s.once('data', d => {
          const m = /^HTTP\/1\.1 (\d+)/.exec(d.toString());
          if (m) statuses.push(Number(m[1]));
        });
        s.on('error', () => {});
        rawSockets.push(s);
      }
      await waitFor(() => statuses.length >= N, 20000);
      const served = statuses.filter(c => c === 200).length;
      const refused = statuses.filter(c => c === 503).length;
      expect(served, 'served more downloads than the cap').to.be.at.most(MAX_GARBAGE);
      expect(refused, 'excess downloads were not refused').to.be.at.least(N - MAX_GARBAGE);
    });

    it('frees a slot when a download ends', async function () {
      this.timeout(30000);
      // The cap counts live downloads: a dropped download must free its slot, or the
      // endpoint would refuse everyone once enough connections had churned through.
      // Fill whatever capacity is free until a download is refused, so the test does
      // not assume how many slots an earlier test has already released.
      const held = [];
      let last;
      do {
        last = await openStatus('ckSize=1024');
        if (last.status === 200) held.push(last);
      } while (last.status === 200 && held.length <= MAX_GARBAGE + 5);
      expect(last.status, 'the cap was never reached').to.equal(503);
      expect(held.length, 'no download was served').to.be.greaterThan(0);
      // drop one held download; its slot must come back
      held[0].sock.destroy();
      await new Promise(r => setTimeout(r, 800));
      expect((await openStatus('ckSize=1024')).status, 'slot not freed after a download ended').to.equal(200);
    });
  });

  describe('slot lifecycle under pipelining and disconnects', function () {
    // The slot is freed from the connection socket's 'close', not the response's, so
    // that neither of the two ways a response ends without emitting its own
    // 'finish'/'close' leaks a slot. Each test drives the whole cap through one such
    // path, drops it, then asserts the cap is free again -- a leak leaves it stuck at
    // 503. The guard the first test checks is independent of the Node version; the leak
    // the second test guards reproduces on the box's Node 12 (verified out of process,
    // since this suite cannot run under the Node version where it strands slots).

    it('does not take a slot for a request whose client disconnected before the handler ran', async function () {
      this.timeout(30000);
      // Codex finding 2. A client can disconnect during the async file lookup
      // express.static does before this router (modelled by the slow=1 middleware). The
      // handler then runs after the response has already emitted 'close', so a slot taken
      // here would never be freed by a later event. The handler must refuse it at entry.
      for (let i = 0; i < MAX_GARBAGE + 4; i++) {
        const s = net.connect(server.address().port, '127.0.0.1', () => {
          s.write(`GET /ss/garbage?slow=1&ckSize=1024 HTTP/1.1\r\nHost: x\r\n\r\n`);
        });
        s.on('error', () => {});
        await new Promise(r => setTimeout(r, 20));
        s.destroy();   // disconnect during the modelled lookup, before the handler runs
        await new Promise(r => setTimeout(r, 20));
      }
      await new Promise(r => setTimeout(r, 1000));
      expect((await get('ckSize=1')).status, 'slots leaked for already-disconnected requests').to.equal(200);
    });

    it('does not leak slots when connections with pipelined downloads drop', async function () {
      this.timeout(30000);
      // Pipelining many downloads on one connection and dropping it must not strand
      // slots. The head response parks at the socket limit and never finishes, so the
      // ones behind it stay queued with no socket of their own; freeing every admitted
      // response from the connection's 'close' (not the response's) keeps repeated rounds
      // from wedging the endpoint at 503. This is the leak that reproduces on Node 12.
      for (let round = 0; round < 3; round++) {
        const sock = net.connect(server.address().port, '127.0.0.1', () => {
          let buf = '';
          for (let i = 0; i < MAX_GARBAGE + 4; i++)
            buf += `GET /ss/garbage?ckSize=1024 HTTP/1.1\r\nHost: x\r\n\r\n`;
          sock.write(buf);
          sock.pause();
        });
        sock.on('error', () => {});
        await new Promise(r => setTimeout(r, 400));
        sock.destroy();
        await new Promise(r => setTimeout(r, 400));
      }
      // Every slot must be free again, not just one: open and hold MAX_GARBAGE downloads
      // and confirm all are served and the next is refused. A single successful request
      // would still pass if the drops had stranded all but one slot (seven of eight on
      // Node 12), since it only needs that one.
      const held = [];
      for (let i = 0; i < MAX_GARBAGE; i++) held.push(await openStatus('ckSize=1024'));
      const served = held.filter(h => h.status === 200).length;
      expect(served, 'not all slots came back after pipelined connections dropped').to.equal(MAX_GARBAGE);
      expect((await openStatus('ckSize=1024')).status, 'cap not enforced after recovery').to.equal(503);
    });
  });
});
