/*    Copyright 2016-2025 Firewalla Inc.
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

const redis = require('redis')
const log = require('../net2/logger.js')(__filename)
const util = require('util')

const Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);
const _ = require('lodash');

// helper functions for scan
redis.RedisClient.prototype.scanAll = async function(pattern, handler, count = 1000) {
  let cursor = 0
  do {
    const result = pattern
      ? await this.scanAsync(cursor, 'MATCH', pattern, 'COUNT', count)
      : await this.scanAsync(cursor, 'COUNT', count);
    cursor = result[0]
    if (result[1].length)
      await handler(result[1])
  } while (cursor != 0)
}

redis.RedisClient.prototype.scanResults = async function(pattern, count = 1000) {
  const allResults = []
  await this.scanAll(pattern, async (results) => {
    while (results.length) allResults.push(results.pop())
  }, count)
  return _.uniq(allResults)
}

// mulit in redis is more like a resource lock other than triditional transaction,
// redis doesn't stop processing commands on error, neither does it rollback any
// multi() with exec() in redis package just pipelines commands
// multi() with exec_transaction() actually wraps commands with multi and exec
// https://redis.io/docs/latest/develop/interact/transactions/
redis.RedisClient.prototype.pipelineAndLog = async function(commands) {
  const multi = this.multi(commands)
  // don't use execAsync() here as it's overwritten with logger
  const results = await util.promisify(multi.exec).bind(multi)()
  for (let i in results) {
    if (results[i] instanceof Error)
      log.error('Error in pipeline', commands[i], results[i])
  }
  return results
}

// overwrites the promisified function with a simple logger
// without command info so all existing code benefits from this
redis.Multi.prototype.execAsync = async function() {
  const results = await util.promisify(this.exec).bind(this)()
  for (let i in results) {
    if (results[i] instanceof Error)
      log.error('Error in pipeline', results[i])
  }
  return results
}

class RedisManager {
  constructor() {
  }

  getRedisClientWithDB1() {
    if(!this.rclientDB1) {
      this.rclientDB1 = redis.createClient({
        host: "localhost",
        db: 1
      })
      this.rclientDB1.on('error', (err) => {
        log.error("Redis client got error:", err);
      })
    }

    return this.rclientDB1
  }

  getRedisClient() {
    if(!this.rclient) {
      this.rclient = redis.createClient()
      this.rclient.on('error', (err) => {
        log.error("Redis client got error:", err);
      })
    }

    return this.rclient
  }

  getBufferRedisClient() {
    if (!this.bclient) {
      // this client will return all replies as buffers instead of strings
      this.bclient = redis.createClient({return_buffers: true});
      this.bclient.on('error', (err) => {
        log.error("Redis buffer client got error:", err);
      });
    }
    return this.bclient;
  }

  getMetricsRedisClient() {
    if(!this.mclient) {
      this.mclient = redis.createClient()
      this.mclient.on('error', (err) => {
        log.error("Redis metrics client got error:", err);
      })
      this.mclientHincrbyBuffer = {};
      this.mclientHincrbyMultiBuffer = {};
      // a helper function to merge multiple hincrby operations on the same key
      this.mclient.hincrbyAndExpireatBulk = async (key, hkey, incr, expr, multi = false) => {
        const bufferKey = `${key}::${hkey}`;
        const buffer = multi ? this.mclientHincrbyMultiBuffer : this.mclientHincrbyBuffer
        if (!buffer.hasOwnProperty(bufferKey)) {
          buffer[bufferKey] = {key, hkey, incr, expr, bulk: 1};
        } else {
          buffer[bufferKey].incr += incr;
          buffer[bufferKey].expr = expr;
          buffer[bufferKey].bulk++;
        }
        if (!multi && buffer[bufferKey].bulk >= 20) {
          const tempBuf = buffer[bufferKey];
          delete buffer[bufferKey];
          await this.mclient.hincrbyAsync(key, hkey, tempBuf.incr);
          await this.mclient.expireatAsync(key, expr);
        }
      };
      this.mclient.execBatch = async () => {
        try {
          const batch = this.mclient.batch()
          for (const k in this.mclientHincrbyMultiBuffer) {
            const {key, hkey, incr, expr} = this.mclientHincrbyMultiBuffer[k];
            batch.hincrby(key, hkey, incr);
            batch.expireat(key, expr);
            delete this.mclientHincrbyMultiBuffer[k];
          }
          await batch.execAsync()
        } catch(err) {
          log.error('Error writing batch', err)
        }
      }

      setInterval(async () => {
        for (const k of Object.keys(this.mclientHincrbyBuffer)) {
          if (this.mclientHincrbyBuffer.hasOwnProperty(k)) {
            const {key, hkey, incr, expr} = this.mclientHincrbyBuffer[k];
            delete this.mclientHincrbyBuffer[k];
            await this.mclient.hincrbyAsync(key, hkey, incr);
            await this.mclient.expireatAsync(key, expr);
          }
        }
      }, 60000);
    }
    return this.mclient
  }

  getSubscriptionClient() {
    if(!this.sclient) {
      this.sclient = redis.createClient()
      this.sclient.setMaxListeners(0)

      this.sclient.on('error', (err) => {
        log.error("Redis sclient got error:", err);
      })
    }

    return this.sclient
  }

  getPublishClient() {
    if(!this.pclient) {
      this.pclient = redis.createClient()
      this.pclient.setMaxListeners(0)

      this.pclient.on('error', (err) => {
        log.error("Redis pclient got error:", err);
      })
    }
    
    return this.pclient
  }
}

module.exports = new RedisManager()
