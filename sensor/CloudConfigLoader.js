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
const log = require('../net2/logger.js')(__filename);

const _ = require('lodash');
const CronJob = require('cron').CronJob;
const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');
const bone = require('../lib/Bone.js');
const SysManager = require('../net2/SysManager.js');

const MAX_ATTEMPTS = 4; // per fetch cycle, then wait for the nightly cron
const RETRY_BASE_MS = 2 * 60 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;

// A sensor setting fetched from a cloud hashset, cached in redis under cacheKey, and pulled again
// once a day. apply(cloudConfig) is called with the cached or fetched config, null when there's none.
// A failed fetch backs off and gives up after MAX_ATTEMPTS, so a cloud outage isn't amplified by the fleet
class CloudConfigLoader {
  // acceptEmpty: an empty config from the cloud is cached and applied too, e.g. a list emptied to withdraw it
  constructor({ cacheKey, hashsetName, label, apply, acceptEmpty = false }) {
    this.cacheKey = cacheKey;
    this.acceptEmpty = acceptEmpty;
    this.hashsetName = hashsetName;
    this.label = label;
    this.apply = apply;
    this.cloudConfig = null;
    this.failures = 0;
    this.inFlight = null;
    this.retryTimer = null;
    this.coolingDown = false;
  }

  // applies the cache right away, the fetch result is applied when it arrives
  async start() {
    await this._applyCached();
    this.reloadNow();
    this._scheduleCron();

    sclient.on("message", (channel, message) => {
      if (channel === Message.MSG_SYS_TIMEZONE_RELOADED) {
        log.info(`System timezone is reloaded, will reschedule ${this.label} config cron job ...`);
        this._scheduleCron();
      }
    });
    sclient.subscribe(Message.MSG_SYS_TIMEZONE_RELOADED);
  }

  // starts a fetch cycle with a fresh budget. Joins the request in flight instead of sending
  // another one, and replaces a pending retry, so cycles never stack
  reloadNow() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
    this.coolingDown = false;
    if (!this.inFlight) this._attempt();
    return this.inFlight;
  }

  // re-applies the cached config, fetching only when there's no cache and no fetch cycle is
  // running or has just given up
  async refresh() {
    await this._applyCached();
    if (_.isEmpty(this.cloudConfig) && !this.inFlight && !this.retryTimer && !this.coolingDown)
      this.reloadNow();
  }

  async _applyCached() {
    this.cloudConfig = await rclient.getAsync(this.cacheKey).then(r => r && JSON.parse(r)).catch(() => null);
    await this.apply(this.cloudConfig);
  }

  _attempt() {
    this.inFlight = this._fetchOnce()
      .catch(err => log.error(`Failed to apply ${this.label} cloud config`, err.message))
      .finally(() => { this.inFlight = null; });
  }

  async _fetchOnce() {
    let body;
    try {
      body = await bone.hashsetAsync(this.hashsetName, { maxAttempts: 1 });
    } catch (err) {
      this._onFailure(err);
      return;
    }
    this.failures = 0;
    let cfg = null;
    try {
      cfg = body && JSON.parse(body);
    } catch (err) {
      log.warn(`Invalid ${this.label} cloud config, keeping the current one`, err.message);
    }
    if (_.isObject(cfg) && (this.acceptEmpty || !_.isEmpty(cfg))) {
      await rclient.setAsync(this.cacheKey, JSON.stringify(cfg));
      this.cloudConfig = cfg;
      await this.apply(cfg);
    }
  }

  _onFailure(err) {
    const status = err.statusCode;
    // a 4xx other than 429 won't change by asking again
    if (status >= 400 && status < 500 && status != 429) {
      log.warn(`Failed to fetch ${this.label} cloud config (${status}), not retrying until the next daily fetch`);
      this.coolingDown = true;
      return;
    }
    this.failures++;
    if (this.failures >= MAX_ATTEMPTS) {
      log.warn(`Failed to fetch ${this.label} cloud config after ${this.failures} attempts, keeping the current config until the next daily fetch`, err.message);
      this.coolingDown = true;
      return;
    }
    const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1));
    const delay = Math.max(backoff * (0.5 + 0.5 * Math.random()), (err.retryAfter || 0) * 1000);
    log.warn(`Failed to fetch ${this.label} cloud config (attempt ${this.failures}/${MAX_ATTEMPTS}), retrying in ${Math.round(delay / 1000)}s`, err.message);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._attempt();
    }, delay);
  }

  _scheduleCron() {
    if (this.reloadJob)
      this.reloadJob.stop();
    if (this.reloadTimeout)
      clearTimeout(this.reloadTimeout);
    const tz = SysManager.getTimezone();
    this.reloadJob = new CronJob("30 23 * * *", async () => { // pull cloud config once every day, the request is sent between 23:30 to 00:00 to avoid calling cloud at the same time
      const delayMins = Math.random() * 30;
      this.reloadTimeout = setTimeout(() => this._dailyReload(), delayMins * 60 * 1000);
    }, () => { }, true, tz);
  }

  // re-applies the cache first, so local config edits take effect even when the fetch fails
  async _dailyReload() {
    await this._applyCached().catch(err => log.error(`Failed to apply cached ${this.label} config`, err.message));
    return this.reloadNow();
  }
}

module.exports = CloudConfigLoader;
