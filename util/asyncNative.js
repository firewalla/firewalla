/*    Copyright 2019-2026 Firewalla Inc.
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
const log = require('../net2/logger.js')(__filename);

async function eachLimit(list, limit, producer) {
  if (!list) return;

  let rest = list.slice(limit);
  let nextIndex = limit
  await Promise.all(list.slice(0, limit).map(async (item, index) => {
    await producer(item, index, list);
    while (rest.length) {
      await producer(rest.shift(), nextIndex ++, list);
    }
  }));
}

async function mapLimit(list, limit, producer) {
  if (!list) return

  let rest = list.slice(limit)
  let nextIndex = limit
  const result = []
  await Promise.all(list.slice(0, limit).map(async (item, index) => {
    result[index] = await producer(item, index, list)
    while (rest.length) {
      result[nextIndex] = await producer(rest.shift(), nextIndex ++, list)
    }
  }));

  return result
}

// note that this is not going to halt promise routine
async function timeout(promise, timeoutInSec) {
  // create error early to catch the call stack
  const err = new Error(`Promise timed out after ${timeoutInSec}s`)
  const timer = new Promise((resolve, reject) => setTimeout(() => {
    reject(err)
  }, timeoutInSec * 1000))
  return Promise.race([promise, timer])
}

const expressAsyncHandler = fn =>
function asyncUtilWrap(...args) {
  const fnReturn = fn(...args)
  const next = args[args.length-1]
  return Promise.resolve(fnReturn).catch(next)
}

function buildDeferred() {
  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });
  return deferred;
}

// Barrier-free, bounded-concurrency consumer for a continuously-fed stream of items.
class LimitedQueue {
  constructor(handler, limit = 1) {
    this._handler = handler;
    this._limit = Math.max(1, limit);
    this._queue = [];
    this._waiters = [];     // deferreds of workers parked on an empty queue
    this._started = false;
  }

  // number of items enqueued but not yet picked up by a worker
  get size() {
    return this._queue.length;
  }

  push(item) {
    if (!this._started) {
      this._started = true;
      for (let i = 0; i < this._limit; i++)
        this._worker();
    }
    this._queue.push(item);
    // hand off to a parked worker if one is waiting; otherwise a busy worker picks it
    // up on its next loop. No await between a worker's empty-check and park, so this
    // never races into a lost wakeup.
    const waiter = this._waiters.shift();
    if (waiter)
      waiter.resolve();
    return this;
  }

  async _worker() {
    for (;;) {
      if (this._queue.length === 0) {
        const deferred = buildDeferred();
        this._waiters.push(deferred);
        await deferred.promise;
        continue;
      }
      const item = this._queue.shift();
      try {
        await this._handler(item);
      } catch (err) {
        log.error('LimitedQueue: handler error', err);
      }
    }
  }
}

module.exports = {
  eachLimit,
  mapLimit,
  timeout,
  expressAsyncHandler,
  buildDeferred,
  LimitedQueue,
}
