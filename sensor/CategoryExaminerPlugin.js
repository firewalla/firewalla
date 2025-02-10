/*    Copyright 2021-2023 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);

const _ = require('lodash');
const LRU = require('lru-cache');
const sl = require('./SensorLoader.js');
const fc = require('../net2/config.js');
const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();
const Sensor = require('./Sensor.js').Sensor;
const bone = require('../lib/Bone');
const Message = require('../net2/Message.js');

const rp = require('request-promise');
const rclient = require('../util/redis_manager.js').getRedisClient();
const CronJob = require('cron').CronJob;

const sem = require('./SensorEventManager.js').getInstance();
const categoryFastFilterFeature = "category_filter";

const scheduler = require('../util/scheduler');
const firewalla = require('../net2/Firewalla.js');
const IntelTool = require('../net2/IntelTool.js');
const intelTool = new IntelTool();

const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Hashes = require('../util/Hashes');
const SysManager = require('../net2/SysManager.js');
const BF_SERVER_MATCH = 'bf_server_match';

const MAX_CONFIRM_SET_SIZE = 20000;
class CategoryExaminerPlugin extends Sensor {
  run() {
    this.confirmSet = new Set();
    const fip = sl.getSensor("FastIntelPlugin");

    this.baseUrl = fip.getIntelProxyBaseUrl();

    this.cache = new LRU({
      max: 1000,
      maxAge: 1000 * 10, // 10 seconds 
      updateAgeOnGet: false
    });

    if (firewalla.isMain()) {
      void this.runConfirmJob();

      void this.scheduleRefreshJob();
      sem.on("REFRESH_CATEGORY_FILTER", (event) => {
        const category = event.category;
        void this.refreshCategoryFilter(category);
      });

      sem.on("DOMAIN_DETECTED", (event) => {
        void this.detectDomain(event.domain);
      });

      sclient.subscribe(BF_SERVER_MATCH);
      sclient.on("message", async (channel, message) => {
        switch (channel) {
          case BF_SERVER_MATCH: {
            log.debug("receive message from", channel, message)
            let msgObj;
            try {
              msgObj = JSON.parse(message);
              await this.detectDomain(msgObj.domain);
            } catch (err) {
              log.error("parse msg failed", err, message);
            }
            break;
          }
          case Message.MSG_SYS_TIMEZONE_RELOADED: {
            log.info("System timezone is reloaded , will reschedule confirm domain cron job ...");
            await this.scheduleRefreshJob();
            break;
          }
        }
      });
    }
    this.hookFeature("category_filter");
  }

  async globalOn(options) {
    log.info("Category filter feature on");
    if (!options || !options.booting) {
      for (const category of categoryUpdater.getActiveCategories()) {
        if (categoryUpdater.isManagedTargetList(category)) {
          sem.emitEvent({
            type: "Policy:CategoryActivated",
            toProcess: "FireMain",
            message: "Category Reload: category_filter feature on: " + category,
            category: category,
            reloadFromCloud: true
          });
        }
      }
    }
  }

  async globalOff() {
    log.info("Category filter feature off");
    for (const category of categoryUpdater.getActiveCategories()) {
      if (categoryUpdater.isManagedTargetList(category)) {
        sem.emitEvent({
          type: "Policy:CategoryActivated",
          toProcess: "FireMain",
          message: "Category Reload: category_filter feature off: " + category,
          category: category,
          reloadFromCloud: true
        });
      }
    }
  }

  isOn() {
    return fc.isFeatureOn(categoryFastFilterFeature) && fc.isFeatureOn("fast_intel");
  }

  async refreshCategoryFilter(category) {
    if (!this.isOn()) {
      return;
    }

    await scheduler.delay(3000);
    const strategy = await categoryUpdater.getStrategy(category);
    if (!strategy.updateConfirmSet) {
      return;
    }

    const redisHitSetKey = categoryUpdater.getHitCategoryKey(category);
    const hitDomains = new Set(await rclient.zrangeAsync(redisHitSetKey, 0, -1));
    const redisPassthroughSetKey = categoryUpdater.getPassthroughCategoryKey(category);
    const passthroughDomains = new Set(await rclient.zrangeAsync(redisPassthroughSetKey, 0, -1));

    // hitDomains - excludeDomain
    const excludeDomains = await categoryUpdater.getExcludedDomains(category.split("_bf")[0]);
    for (const domain of hitDomains) {
      if (excludeDomains.includes(domain)) {
        log.info(`Add domain ${domain} to passthrough set of ${category}`);
        await this.addDomainToPassthroughSet(category, domain, Date.now())
        log.info(`Remove ${domain} from hit set of ${category}`);
        await this.removeDomainFromHitSet(category, domain);
        hitDomains.delete(domain);
      }
    }

    const allDomains = new Set();
    for (const domain of hitDomains) {
      allDomains.add(domain);
    }
    for (const domain of passthroughDomains) {
      allDomains.add(domain);
    }
    if (allDomains.size === 0) {
      return;
    }

    const confirmMatchList = [];
    const hitRemoveSet = new Set();
    const passthroughRemoveSet = new Set();

    for (const domain of allDomains) {
      let response;
      try {
        response = await this.matchDomain(domain, category);
      } catch (e) {
        confirmMatchList.push(domain);
        continue;
      }
      const result = response.results[0];
      if (result && result.uid === `category:${category}` && result.status !== "NoMatch") {
        confirmMatchList.push(domain);
      } else {
        if (hitDomains.has(domain)) {
          hitRemoveSet.add(domain);
        }
        if (passthroughDomains.has(domain)) {
          passthroughRemoveSet.add(domain);
        }
      }
    }

    log.info(`Refresh ${confirmMatchList.length} domains in category hit/passthrough: ${category}`);
    const results = await this.confirmDomains(category, strategy, confirmMatchList);
    if (results === null) {
      log.error("Fail to refresh domains of category. Abort refresh process", category);
      return;
    }

    const finalHitMatchSet = new Set(results);
    for (const domain of confirmMatchList) {
      if (hitDomains.has(domain) && !finalHitMatchSet.has(domain)) {
        hitRemoveSet.add(domain);
      }
      if (passthroughDomains.has(domain) && finalHitMatchSet.has(domain)) {
        passthroughRemoveSet.add(domain);
      }
    }

    if (hitRemoveSet.size > 0 || passthroughRemoveSet.size > 0) {
      for (const domain of hitRemoveSet) {
        log.info(`Remove ${domain} from hit set of ${category}`);
        await this.removeDomainFromHitSet(category, domain);
      }
      for (const domain of passthroughRemoveSet) {
        log.info(`Remove ${domain} from passthrough set of ${category}`);
        await this.removeDomainFromPassthroughSet(category, domain);
      }
      this.sendUpdateNotification(category);
    }

  }

  async matchDomain(domain, category = null) {

    let filters;
    if (category) {
      filters = [`category:${category}`];
    } else {
      filters = [];
    }

    const options = {
      uri: `${this.baseUrl}/check_filter`,
      family: 4,
      method: "POST",
      json: true,
      body: {
        domain: domain,
        filters: filters
      }
    };
    return await rp(options);
  }

  async detectDomain(origDomain) {

    if (this.cache.get(origDomain)) {
      return;
    }
    log.debug("Detect domain", origDomain);

    this.cache.set(origDomain, true);

    if (!this.isOn()) {
      return;
    }

    let response;
    try {
      response = await this.matchDomain(origDomain);
    } catch (e) {
      log.warn(`Fail to get match result from category filter: ${origDomain}`);
      return;
    }
    const categories = response.results.filter(result => result.status == 'Match').map((result) => {const [, c] = result.uid.split(':'); return c});
    const excludeDomains = await this._getCategoryExcludeDomains(_.uniq(categories));

    for (const result of response.results) {
      const status = result.status;
      const [, category] = result.uid.split(":");
      const matchedDomain = result.item;
      if (!categoryUpdater.isActivated(category)) {
        // do not check if category is not activated
        continue;
      }
      if (status === "Match") {
        // Check if the <domain, category> pair is already in hit set. If so, skip confirmation.
        if (await this.isInHitSet(category, matchedDomain)) {
          log.debug(`${origDomain} already in hit set of ${category}`);
          // check if exclude domain
          if (!excludeDomains[category].includes(matchedDomain)) {
            await this.addDomainToHitSet(category, matchedDomain, Date.now());
          }
          continue;
        }
        if (await this.isInPassthroughSet(category, origDomain)) {
          log.debug(`${origDomain} already in passthrough set of ${category}`);
          await this.addDomainToPassthroughSet(category, matchedDomain, Date.now());
          continue;
        }

        log.debug(`Check ${origDomain} in category filter: ${category}`);
        this.confirmSet.add(`${category}:${matchedDomain}:${origDomain}`);
      }
    }
  }

  async _getCloudIntels(domain) {
    const resp = await intelTool.checkIntelFromCloud(null, domain);
    if (!_.isArray(resp) || resp.length == 0) {
      return [];
    }
    return resp;
  }

  async _getCategoryExcludeDomains(categories) {
    let excludeDomains = {};
    for (const c of categories) {
      const domains = await categoryUpdater.getExcludedDomains(c.split("_bf")[0]);
      excludeDomains[c] = domains;
    }
    return excludeDomains;
  }

  async confirmJob() {
    if (this.confirmSet.size == 0) {
      return;
    }
    log.info("category examiner run comfirm job", JSON.stringify(JSON.stringify([...this.confirmSet])));
    const categoryDomainMap = new Map();
    for (const item of this.confirmSet) {
      const [category, matchedDomain, origDomain] = item.split(":");
      if (!categoryDomainMap.has(category)) {
        categoryDomainMap.set(category, [[matchedDomain, origDomain]]);
      } else {
        categoryDomainMap.get(category).push([matchedDomain, origDomain]);
      }
    }

    const categories = categoryDomainMap.keys()
    const excludeDomains = await this._getCategoryExcludeDomains(categories);

    this.confirmSet = new Set();
    for (const [category, domainList] of categoryDomainMap) {
      const strategy = await categoryUpdater.getStrategy(category);
      // update hit set using matched domain list
      if (strategy.updateConfirmSet) {
        let score = Date.now();
        if (!category.endsWith('_bf') && category != "adblock_strict") {
          await this._confirmCloudCategoryDomains(category, strategy, domainList, score);
          continue;
        }
        let originCategory = category.split("_bf")[0];
        if (originCategory === "adblock_strict")
          originCategory = "ad";
        const origDomainList = domainList.map(item => item[1]);
        const unmatchedOrigDomainSet = new Set(origDomainList);
        for (let i = 0; i < origDomainList.length; i++) {
          const origDomain = origDomainList[i];
          const intels = await this._getCloudIntels(origDomain).catch((err) => null);
          if (!intels) { // likely error occurs while calling cloud API, do not block or passthrough this domain
              unmatchedOrigDomainSet.delete(origDomain);
              continue;
          }
          log.verbose("categories", category, intels, origDomain);
          const longestMatchIntel = _.maxBy(intels, (cat) => {
            return (cat.originIP || "").length;
          })
          if (_.isObject(longestMatchIntel) && (longestMatchIntel.c === category || longestMatchIntel.c === originCategory)) { // matched with cloud data
            // add domain/pattern matched from cloud to hit set
            const domain = longestMatchIntel.originIP || origDomain;
            log.info(`Add domain ${domainList[i][0]} to hit set of ${category} `);

            // check excludeDomains
            if (!excludeDomains[category] || !excludeDomains[category].includes(domainList[i][0])) {
              await this.addDomainToHitSet(category, domainList[i][0], score);
            } else {
              await this.addDomainToPassthroughSet(category, origDomain, score);
            }
            // incremental update original category with the matched domain from cloud, including ipset and tls host set
            if (domainList[i][0] == "*." + domain) {
              await categoryUpdater.updateDomain(originCategory, domainList[i][0], false);
            } else {
              await categoryUpdater.updateDomain(originCategory, domain, domain !== origDomain);
            }
            unmatchedOrigDomainSet.delete(origDomain);
            await intelTool.addDomainIntel(domain, longestMatchIntel, longestMatchIntel.e);
          }
        }

        for (const origDomain of unmatchedOrigDomainSet) {
          log.info(`Add domain ${origDomain} to passthrough set of ${category} `);
          await this.addDomainToPassthroughSet(category, origDomain, score);
        }

        await this.limitHitSet(category, MAX_CONFIRM_SET_SIZE);
        await this.limitPassthroughSet(category, MAX_CONFIRM_SET_SIZE);
      }
    }
  }

  // category: oisd
  async _confirmCloudCategoryDomains(category, strategy, domainList, score) {
    const matchedDomainList = domainList.map(item => item[0]); // send matched domains from local bf to cloud for confirmation, original domain can be a subdomain of matched domain
    let results = await this.confirmDomains(category, strategy, matchedDomainList);
    if (results === null) {
      log.debug("Fail to confirm domains of category", category);
      return;
    }
    const positiveSet = new Set(results);
    const unmatchedOrigDomainSet = new Set(domainList.map(item => item[1]));
    for (const [matchedDomain, origDomain] of domainList) {
      if (positiveSet.has(matchedDomain)) {
        log.info(`Add domain ${matchedDomain} to hit set of ${category} `);
        await this.addDomainToHitSet(category, matchedDomain, score);
        unmatchedOrigDomainSet.delete(origDomain);
      }
    }
    for (const origDomain of unmatchedOrigDomainSet) {
      log.info(`Add domain ${origDomain} to passthrough set of ${category} `);
      await this.addDomainToPassthroughSet(category, origDomain, score);
    }
    await this.limitHitSet(category, MAX_CONFIRM_SET_SIZE);
    await this.limitPassthroughSet(category, MAX_CONFIRM_SET_SIZE);

    this.sendUpdateNotification(category);
  }

  async runConfirmJob() {
    while (true) {
      await this.confirmJob().catch((err) => {
        log.error("Confirm job failed", err);
      });
      await scheduler.delay(2000);
    }
  }

  async scheduleRefreshJob() {
    if (this.refreshJob)
      this.refreshJob.stop();
    if (this.refreshTimeout)
      clearTimeout(this.refreshTimeout);
    const tz = SysManager.getTimezone();
    // confirm all hit domains on all active categories is resource consuming, no need to run periodical confirm too frequently,
    // if category bloomfilter is updated, a REFRESH_CATEGORY_FILTER event will be triggered, and refreshCategoryFilter will be called on the updated category at that time
    this.refreshJob = new CronJob("0 3 * * *", async () => {
      const delayMins = Math.random() * 120; // a random time between 3 a.m. and 5 a.m.
      this.refreshTimeout = setTimeout(async () => {
        for (const category of categoryUpdater.getActiveCategories()) {
          await this.refreshCategoryFilter(category);
        }
      }, delayMins * 60 * 1000);
    }, () => {}, true, tz);
  }

  async confirmDomains(category, strategy, domainList) {
    if (strategy.checkCloud) {
      try {
        const result = await this.confirmDomainsFromCloud(category, domainList);
        return result;
      } catch (e) {
        log.error("Check cloud target set error:", category, domainList, e.message);
      }
    }
    log.debug("All confirmation failed for domain:", category);
    return null;
  }

  async confirmDomainsFromCloud(category, domainList) {
    log.debug("Try to confirm domains from cloud:", category, domainList);
    const hashedDomainList = domainList.map(domain => Hashes.getHashObject(domain).hash.toString('base64'));
    const requestObj = {
      id: CategoryUpdater.getCategoryHashsetMapping()[category] || `app.${category}`,
      domains: hashedDomainList
    };
    const response = await bone.checkTargetSetMembership(requestObj);
    if (!response || !response.domains) {
      throw new Error("Check cloud error");
    }
    const resultHashSet = new Set(response.domains);

    const result = [];
    for (let i = 0; i < domainList.length; i++) {
      if (resultHashSet.has(hashedDomainList[i])) {
        result.push(domainList[i]);
      }
    }
    return result;
  }

  isMatch(domain, line) {
    if (domain === line) {
      return true;
    }
    const tokens = domain.split(".");
    for (let i = 1; i < tokens.length - 1; i++) {
      const toMatchPattern = "*." + tokens.slice(i).join(".");
      if (toMatchPattern === line) {
        return true;
      }
    }
    return false;
  }

  async isInHitSet(category, domain) {
    const redisHitSetKey = categoryUpdater.getHitCategoryKey(category);
    const exists = await rclient.zscoreAsync(redisHitSetKey, domain);
    if (exists === null) {
      return false;
    }
    return true;
  }

  async isInPassthroughSet(category, domain) {
    const redisPassthroughSetKey = categoryUpdater.getPassthroughCategoryKey(category);
    const exists = await rclient.zscoreAsync(redisPassthroughSetKey, domain);
    if (exists === null) {
      return false;
    }
    return true;
  }

  async addDomainToHitSet(category, domain, score) {
    const redisHitSetKey = categoryUpdater.getHitCategoryKey(category);
    await rclient.zaddAsync(redisHitSetKey, score, domain);
  }

  async removeDomainFromHitSet(category, domain) {
    const redisHitSetKey = categoryUpdater.getHitCategoryKey(category);
    await rclient.zremAsync(redisHitSetKey, domain);
  }

  async addDomainToPassthroughSet(category, domain, score) {
    const redisPassthroughSetKey = categoryUpdater.getPassthroughCategoryKey(category);
    await rclient.zaddAsync(redisPassthroughSetKey, score, domain);
  }

  async removeDomainFromPassthroughSet(category, domain) {
    const redisPassthroughSetKey = categoryUpdater.getPassthroughCategoryKey(category);
    await rclient.zremAsync(redisPassthroughSetKey, domain);
  }

  async trimRedisZset(key, maxLimit) {
    const count = await rclient.zcardAsync(key);
    if (count > maxLimit) {
      const toRemoveCount = count - maxLimit;
      await rclient.zremrangebyrankAsync(key, 0, toRemoveCount - 1);
      log.debug(`Limit confirm set size: delete ${toRemoveCount} element from ${key}`);
    }
  }

  async limitHitSet(category, maxLimit) {
    const redisHitSetKey = categoryUpdater.getHitCategoryKey(category);
    await this.trimRedisZset(redisHitSetKey, maxLimit);
  }

  async limitPassthroughSet(category, maxLimit) {
    const redisPassthroughSetKey = categoryUpdater.getPassthroughCategoryKey(category);
    await this.trimRedisZset(redisPassthroughSetKey, maxLimit);
  }

  sendUpdateNotification(category) {
    const event = {
      type: "UPDATE_CATEGORY_HITSET",
      category: category
    };
    sem.sendEventToAll(event);
  }
}

module.exports = CategoryExaminerPlugin;
