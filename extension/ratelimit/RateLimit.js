/*    Copyright 2019 Firewalla INC
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

const rclient = require('../../util/redis_manager.js').getRedisClient();

let instance = null;
const key = "ratelimit";
const cleanupInterval = 3600 * 1000;
const max = 100;

const _ = require('lodash');

const log = require('../../net2/logger.js')(__filename);

class RateLimit {
  constructor() {
    if(instance === null) {
      instance = this;

      this.lastTS = null;
      this.lastUsed = null;
      this.lastLimit = null;
      this.lastDuration = null;

      this.cleanup();
      setInterval(() => {
        this.cleanup();
      }, cleanupInterval);
    }

    return instance;
  }

  async cleanup() {
    return rclient.zremrangebyrankAsync(key, 0, -1 * max);
  }

  async recordRate(headers = {}) {
    const expireDate = headers["x-ratelimit-reset"];
    const limit = headers["x-ratelimit-limit"];
    const remaining = headers["x-ratelimit-remaining"];
    const duration = headers["x-ratelimit-duration"];
    if(!expireDate || !limit || !remaining || !duration) {
      return;
    }

    const used = limit - remaining;

    const ts = Math.floor(Number(expireDate) / 1000 / 30);

    // time to eject to redis
    if(this.lastTS && this.lastTS !== ts) {
      // this records rate limit for every cycle
      const result = JSON.stringify({
        used: this.lastUsed, 
        limit: this.lastLimit,
        duration: this.lastDuration
      });
      await rclient.zaddAsync(key, this.lastTS, result);
    }

    this.lastTS = ts;
    this.lastUsed = used;
    this.lastLimit = limit;
    this.lastDuration = duration;
  }

  async getLastTS() {
    const results = await rclient.zrangeAsync(key, -1, -1, "withscores");
    if(_.isEmpty(results)) {
      return null;
    }

    const payload = results[0];
    const ts = Number(results[1]) * 30;

    try {
      const data = JSON.parse(payload);
      data.ts = ts;
      return data;
    } catch(err) {
      log.error(`Failed to parse rate limit payload: ${payload}, err: ${err}`);
      return null;
    }
  }
}

module.exports = new RateLimit();
