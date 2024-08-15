/*    Copyright 2016-2024 Firewalla Inc.
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

const Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);
const _ = require('lodash');

class RedisManager {
  constructor() {
  }

  getRedisClient() {
    if(!this.rclient) {
      this.rclient = redis.createClient()
      this.rclient.on('error', (err) => {
        log.error("Redis client got error:", err);
      })

      // helper functions for scan
      this.rclient.scanAll = async (pattern, handler, count = 1000) => {
        let cursor = 0
        do {
          const result = pattern ? await this.rclient.scanAsync(cursor, 'MATCH', pattern, 'COUNT', count) : await this.rclient.scanAsync(cursor, 'COUNT', count);
          cursor = result[0]
          if (result[1].length)
            await handler(result[1])
        } while (cursor != 0)
      }

      this.rclient.scanResults = async (pattern, count = 1000) => {
        const allResults = []
        await this.rclient.scanAll(pattern, async (results) => {
          while (results.length) allResults.push(results.pop())
        }, count)
        return _.uniq(allResults)
      }
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
