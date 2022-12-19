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
'use strict';

const redis = require('redis')
const log = require('../net2/logger.js')(__filename)

const Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);
const _ = require('lodash');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();

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
          const result = await this.rclient.scanAsync(cursor, 'MATCH', pattern, 'COUNT', count);
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
      // a helper function to merge multiple hincrby operations on the same key
      this.mclient.hincrbyAndExpireatBulk = async (key, hkey, incr, expr) => {
        const bufferKey = `${key}::${hkey}`;
        await lock.acquire(bufferKey, async () => {// fine-grained mutually-exclusive lock
          if (!this.mclientHincrbyBuffer.hasOwnProperty(bufferKey)) {
            this.mclientHincrbyBuffer[bufferKey] = {key, hkey, incr, expr, bulk: 1};
          } else {
            this.mclientHincrbyBuffer[bufferKey].incr += incr;
            this.mclientHincrbyBuffer[bufferKey].expr = expr;
            this.mclientHincrbyBuffer[bufferKey].bulk++;
          }
          if (this.mclientHincrbyBuffer[bufferKey].bulk >= 20) {
            await this.mclient.hincrbyAsync(key, hkey, this.mclientHincrbyBuffer[bufferKey].incr);
            await this.mclient.expireatAsync(key, expr);
            delete this.mclientHincrbyBuffer[bufferKey];
          }
        }).catch((err) => {});
      };
      setInterval(async () => {
        for (const k of Object.keys(this.mclientHincrbyBuffer)) {
          await lock.acquire(k, async () => {
            if (this.mclientHincrbyBuffer.hasOwnProperty(k)) {
              const {key, hkey, incr, expr} = this.mclientHincrbyBuffer[k];
              await this.mclient.hincrbyAsync(key, hkey, incr);
              await this.mclient.expireatAsync(key, expr);
              delete this.mclientHincrbyBuffer[k];
            }
          }).catch((err) => {});
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
