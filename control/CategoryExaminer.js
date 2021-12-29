/*    Copyright 2021 Firewalla Inc.
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

const LRU = require('lru-cache');
const sl = require('../sensor/SensorLoader.js');
const fc = require('../net2/config.js');
const CategoryUpdater = require('./CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();

const rp = require('request-promise');
const rclient = require('../util/redis_manager.js').getRedisClient();

const sem = require('../sensor/SensorEventManager.js').getInstance();
const fs = require('fs');
const readline = require('readline');
const categoryFastFilterFeature = "category_filter";
const scheduler = require('../util/scheduler');
const _ = require('lodash');
const firewalla = require('../net2/Firewalla.js');
const { Readable, Transform, Writable, pipeline } = require('stream');
const util = require('util');
const fireUtil = require('../util/util');
const pipelineAsync = util.promisify(pipeline);

const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const BF_SERVER_MATCH = 'bf_server_match';

class CategoryExaminer {
  constructor() {
    this.confirmSet = new Set();
    this.cache = new LRU({
      max: 1000,
      maxAge: 1000 * 10, // 10 seconds 
      updateAgeOnGet: false
    });
    if (firewalla.isMain()) {
      void this.runConfirmJob();

      void this.runRefreshJob();
      sem.on("REFRESH_CATEGORY_FILTER", (event) => {
        const category = event.category;
        void this.refreshCategoryFilter(category);
      });

      sclient.subscribe(BF_SERVER_MATCH);
      sclient.on("message", async (channel, message) => {
        switch (channel) {
          case BF_SERVER_MATCH: {
            let msgObj;
            try {
              msgObj = JSON.parse(message);
              await this.detectDomain(msgObj.domain);
            } catch (err) {
              log.error("parse msg failed", err, message);
            }
          }
        }
      });
    }
  }

  async refreshCategoryFilter(category) {
    await scheduler.delay(3000);
    const strategy = await categoryUpdater.getStrategy(category);
    if (!strategy.updateConfirmSet) {
      return;
    }

    const redisHitSetKey = categoryUpdater.getHitCategoryKey(category);
    const hitDomains = new Set(await rclient.zrangeAsync(redisHitSetKey, 0, -1));
    const redisPassthroughSetKey = categoryUpdater.getPassthroughCategoryKey(category);
    const passthroughDomains = new Set(await rclient.zrangeAsync(redisPassthroughSetKey, 0, -1));

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


    let results;
    log.info(`Refresh ${confirmMatchList.length} domains in category hit/passthrough: ${category}`);
    try {
      if (strategy.checkFile) {
        results = await this.confirmDomainsFromFile(category, confirmMatchList);
      } else if (strategy.checkCloud) {
        results = await this.confirmDomainsFromCloud(category, confirmMatchList);
      } else {
        results = confirmMatchList;
      }
    } catch (e) {
      log.error("Fail to refresh domains of category. Abort refresh process", category, e);
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
        log.debug(`Remove ${domain} from hit set of ${category}`);
        await this.removeDomainFromHitSet(category, domain);
      }
      for (const domain of passthroughRemoveSet) {
        log.debug(`Remove ${domain} from passthrough set of ${category}`);
        await this.removeDomainFromPassthroughSet(category, domain);
      }
      this.sendUpdateNotification(category);
    }

  }

  async matchDomain(domain, category = null) {
    const fip = sl.getSensor("FastIntelPlugin");
    if (!fip || !fc.isFeatureOn(categoryFastFilterFeature)) { // no plugin found
      return {
        results: []
      };
    }

    let filters;
    if (category) {
      filters = [`category:${category}`];
    } else {
      filters = [];
    }
    const baseURL = fip.getIntelProxyBaseUrl();

    const options = {
      uri: `${baseURL}/check_filter`,
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

    let response;
    try {
      response = await this.matchDomain(origDomain);
    } catch (e) {
      log.error(`Fail to get match result from category filter: ${origDomain}`);
      return;
    }

    for (const result of response.results) {
      const status = result.status;
      const [, category] = result.uid.split(":");
      const matchedDomain = result.item;
      if (status === "Match") {
        // Check if the <domain, category> pair is already in hit set. If so, skip confirmation from file or network.
        const hitSetKey = categoryUpdater.getHitCategoryKey(category);
        const hitSetExists = await rclient.zscoreAsync(hitSetKey, matchedDomain);
        if (hitSetExists !== null) {
          log.debug(`${origDomain} already in hit set of ${category}`);
          continue;
        }
        const passthroughSetKey = categoryUpdater.getPassthroughCategoryKey(category);
        const passthroughSetExists = await rclient.zscoreAsync(passthroughSetKey, origDomain);
        if (passthroughSetExists !== null) {
          log.debug(`${origDomain} already in passthrough set of ${category}`);
          continue;
        }

        log.debug(`Check ${origDomain} in category filter: ${category}`);
        this.confirmSet.add(`${category}:${matchedDomain}:${origDomain}`);
      }
    }
  }

  async confirmJob() {
    const categoryDomainMap = new Map();
    for (const item of this.confirmSet) {
      const [category, matchedDomain, origDomain] = item.split(":");
      if (!categoryDomainMap.has(category)) {
        categoryDomainMap.set(category, [[matchedDomain, origDomain]]);
      } else {
        categoryDomainMap.get(category).push([matchedDomain, origDomain]);
      }
    }

    this.confirmSet = new Set();

    for (const [category, domainList] of categoryDomainMap) {
      const strategy = await categoryUpdater.getStrategy(category);
      const origDomainList = domainList.map(item => item[1]);
      let changed = false;

      // update hit set using matched domain list
      if (strategy.updateConfirmSet) {
        let results;
        try {
          if (strategy.checkFile) {
            results = await this.confirmDomainsFromFile(category, origDomainList);
          } else if (strategy.checkCloud) {
            results = await this.confirmDomainsFromCloud(category, origDomainList);
          } else {
            results = origDomainList;
          }
        } catch (e) {
          results = origDomainList;
          log.error("Fail to confirm domains of category, add it to hit set anyway", category, e);
        }
        const positiveSet = new Set(results);
        for (const [matchedDomain, origDomain] of domainList) {
          if (positiveSet.has(origDomain)) {
            if (await this.addDomainToHitSet(category, matchedDomain)) {
              changed = true;
            }
          } else {
            if (await this.addDomainToPassthroughSet(category, origDomain)) {
              changed = true;
            }
          }

        }
      }
      if (changed) {
        this.sendUpdateNotification(category);
      }
    }
  }

  async runConfirmJob() {
    while (true) {
      await this.confirmJob();
      await scheduler.delay(2000);
    }
  }

  async runRefreshJob() {
    while (true) {
      await scheduler.delay(1000 * 60 * 10); // 10 min
      for (const category of categoryUpdater.getActiveCategories()) {
        await this.refreshCategoryFilter(category);
      }
    }
  }

  async confirmDomainsFromFile(category, domainList) {
    const fileStream = fs.createReadStream(`${categoryUpdater.getCategoryRawListDir()}/${category}.lst`);
    const domainStreamMatcher = new DomainStreamMatcher(domainList);
    await pipelineAsync(fileStream,
      new fireUtil.LineSplitter(),
      domainStreamMatcher
    );
    return domainStreamMatcher.getResult();
  }

  async confirmDomainsFromCloud(category, domainList) {
    return [];
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

  async addDomainToHitSet(category, domain) {
    const redisHitSetKey = categoryUpdater.getHitCategoryKey(category);
    const exists = await rclient.zscoreAsync(redisHitSetKey, domain);
    if (exists === null) {
      log.info(`Add domain ${domain} to hit set of ${category} `);
      await rclient.zaddAsync(redisHitSetKey, 1, domain);
      return true;
    }
    return false;
  }

  async removeDomainFromHitSet(category, domain) {
    const redisHitSetKey = categoryUpdater.getHitCategoryKey(category);
    await rclient.zremAsync(redisHitSetKey, domain);
  }

  async addDomainToPassthroughSet(category, domain) {
    const redisPassthroughSetKey = categoryUpdater.getPassthroughCategoryKey(category);
    const exists = await rclient.zscoreAsync(redisPassthroughSetKey, domain);
    if (exists === null) {
      log.info(`Add domain ${domain} to passthrough set of ${category} `);
      await rclient.zaddAsync(redisPassthroughSetKey, 1, domain);
      return true;
    }
    return false;
  }

  async removeDomainFromPassthroughSet(category, domain) {
    const redisPassthroughSetKey = categoryUpdater.getPassthroughCategoryKey(category);
    await rclient.zremAsync(redisPassthroughSetKey, domain);
  }

  sendUpdateNotification(category) {
    const event = {
      type: "UPDATE_CATEGORY_HITSET",
      category: category
    };
    sem.sendEventToAll(event);
    sem.emitLocalEvent(event);
  }
}


class DomainStreamMatcher extends Writable {
  constructor(matchList) {
    super();
    this.matchList = matchList;
    this.result = [];
  }

  _write(line, enc, cb) {
    const target = line.toString();
    for (const item of this.matchList) {
      if (this.isMatch(item, target)) {
        this.result.push(item);
      }
    }
    cb(null);
  }

  isMatch(domain, line) {
    if (domain === line) {
      return true;
    }
    const tokens = domain.split(".");
    for (let i = 0; i < tokens.length - 1; i++) {
      const toMatchPattern = "*." + tokens.slice(i).join(".");
      if (toMatchPattern === line) {
        return true;
      }
    }
    return false;
  }
  _end() {
  }

  getResult() {
    return this.result;
  }
}

module.exports = new CategoryExaminer();