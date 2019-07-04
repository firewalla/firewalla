'use strict';

const rclient = require('../../util/redis_manager.js').getRedisClient();

let instance = null;
const key = "ratelimit";
const cleanupInterval = 3600 * 1000;
const max = 2016;

class RateLimit {
  constructor() {
    if(instance === null) {
      instance = this;

      this.cleanup();
      setInterval(() => {
        this.cleanup();
      });
    }

    return instance;
  }

  async cleanup() {
    return rclient.zremrangebyrankAsync(key, 0, -1 * max);
  }

  async recordRate(headers = {}) {
    const expireDate = headers["X-RateLimit-Reset"];
    const limit = headers["X-RateLimit-Limit"];
    const remaining = headers["X-RateLimit-Remaining"];
    if(!expireDate || !limit || !remaining) {
      return;
    }

    const used = limit - remaining;

    // this records rate limit for every cycle
    await rclient.zaddAsync(key, expireDate, used);
  }
}

module.exports = new RateLimit();