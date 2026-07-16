/*    Copyright 2016-2026 Firewalla Inc.
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

const { LimitedQueue } = require('../util/asyncNative.js');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('LimitedQueue', () => {

  it('pushAndWait resolves with the handler return value', async () => {
    const q = new LimitedQueue(async x => x * 2, 4);
    expect(await q.pushAndWait(21)).to.equal(42);
  });

  it('returns results in caller order for many concurrent pushAndWait', async () => {
    // varying per-item delay so completion order differs from submission order
    const q = new LimitedQueue(async x => { await delay(x % 7); return x * x; }, 5);
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => q.pushAndWait(i)));
    expect(results).to.eql(Array.from({ length: 50 }, (_, i) => i * i));
  });

  it('processes every fire-and-forget push exactly once', async () => {
    const seen = [];
    const q = new LimitedQueue(async x => { seen.push(x); }, 3);
    for (let i = 0; i < 20; i++) q.push(i);
    await delay(50);
    expect(seen).to.have.lengthOf(20);
    expect(new Set(seen).size).to.equal(20);
  });

  it('never runs more than `limit` handlers concurrently', async () => {
    let inFlight = 0, maxInFlight = 0;
    const limit = 4;
    const q = new LimitedQueue(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(15);
      inFlight--;
    }, limit);
    await Promise.all(Array.from({ length: 30 }, () => q.pushAndWait()));
    expect(maxInFlight).to.be.at.most(limit);
    expect(maxInFlight).to.equal(limit); // 30 items / 15ms ensures every slot is used
  });

  it('processes items in FIFO order with limit 1', async () => {
    const order = [];
    const q = new LimitedQueue(async x => { await delay(2); order.push(x); }, 1);
    const items = [1, 2, 3, 4, 5];
    await Promise.all(items.map(x => q.pushAndWait(x)));
    expect(order).to.eql(items);
  });

  it('picks up items enqueued while all workers are busy', async () => {
    const seen = [];
    const q = new LimitedQueue(async x => { await delay(20); seen.push(x); }, 2);
    // first 2 occupy both workers; 3,4,5 must queue and then get picked up
    await Promise.all([1, 2, 3, 4, 5].map(x => q.pushAndWait(x)));
    expect(seen.sort((a, b) => a - b)).to.eql([1, 2, 3, 4, 5]);
  });

  it('rejects pushAndWait when the handler throws, and the worker survives', async () => {
    const q = new LimitedQueue(async x => {
      if (x === 'bad') throw new Error('boom');
      return x;
    }, 2);

    let caught = null;
    try {
      await q.pushAndWait('bad');
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.an('error');
    expect(caught.message).to.equal('boom');

    // worker must still be alive and serving subsequent items
    expect(await q.pushAndWait('good')).to.equal('good');
  });

  it('survives a throwing handler on fire-and-forget push', async () => {
    const seen = [];
    const q = new LimitedQueue(async x => {
      if (x === 2) throw new Error('boom');
      seen.push(x);
    }, 1);
    [1, 2, 3].forEach(x => q.push(x));
    await delay(30);
    expect(seen).to.eql([1, 3]); // 2 threw, worker kept going
  });

  it('reports the backlog via size', async () => {
    const q = new LimitedQueue(async () => { await delay(80); }, 1);
    expect(q.size).to.equal(0);
    q.push('a'); q.push('b'); q.push('c');
    await delay(10);            // one item picked up, two still queued
    expect(q.size).to.equal(2);
    await delay(300);           // everything drained
    expect(q.size).to.equal(0);
  });

  it('wakes a parked worker when work arrives after the queue drained', async () => {
    const seen = [];
    const q = new LimitedQueue(async x => { seen.push(x); }, 2);
    await q.pushAndWait('first');  // drains, both workers park on empty queue
    await delay(20);
    await q.pushAndWait('second'); // must wake a parked worker to make progress
    expect(seen).to.eql(['first', 'second']);
  });

  it('defaults to a single worker (serial) when no limit is given', async () => {
    let inFlight = 0, maxInFlight = 0;
    const q = new LimitedQueue(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight--;
    });
    await Promise.all(Array.from({ length: 5 }, () => q.pushAndWait()));
    expect(maxInFlight).to.equal(1);
  });

  it('clamps a non-positive limit to 1', async () => {
    const q = new LimitedQueue(async x => x, 0);
    expect(q.limit).to.equal(1);
    expect(await q.pushAndWait('x')).to.equal('x');
  });
});
