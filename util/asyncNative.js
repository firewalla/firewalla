/*    Copyright 2019-2022 Firewalla Inc.
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

module.exports = {
  eachLimit,
  mapLimit,
  timeout,
}
