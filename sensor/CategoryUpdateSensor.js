/*    Copyright 2016-2023 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient()

const fc = require('../net2/config.js')

const Sensor = require('./Sensor.js').Sensor;

const sem = require('../sensor/SensorEventManager.js').getInstance();

const bone = require('../lib/Bone.js');

const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();
const CountryUpdater = require('../control/CountryUpdater.js');
const countryUpdater = new CountryUpdater();
const ExceptionManager = require('../alarm/ExceptionManager.js');
const exceptionManager = new ExceptionManager();

const { Address4, Address6 } = require('ip-address');

const { isHashDomain } = require('../util/util.js');

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const util = require('util');

const fs = require('fs');
const { execSync } = require('child_process');
const cloudcache = require('../extension/cloudcache/cloudcache');
const writeFileAsync = util.promisify(fs.writeFile);
const readFileAsync = util.promisify(fs.readFile);
const renameAsync = util.promisify(fs.rename);
const unlinkAsync = util.promisify(fs.unlink);
const crypto = require('crypto');

const _ = require('lodash');
const Message = require('../net2/Message.js');
const { CategoryEntry } = require('../control/CategoryEntry.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_BF_DATA = "LOCK_BF_DATA";
const LOCK_BF_CONF = "LOCK_BF_CONF";

const INTEL_PROXY_CHANNEL = "intel_proxy";

const MAX_DOMAIN_PORT_COUNT = 1000;
const MAX_IP_PORT_COUNT = 20000;

const securityHashMapping = {
  "default_c": "blockset:default:consumer"
}

const CATEGORY_DATA_KEY = "intel_proxy.data";
const Constants = require('../net2/Constants.js');

// fallbacks in case a sensor config override omits one of these fields;
// setInterval() clamps a NaN delay to 1ms instead of erroring out
const DEFAULT_REGULAR_INTERVAL = 28800;
// How long to hold a bf-driven dnsmasq restart so a batch of filter updates costs one restart
// instead of one per category. A cloud rebuild publishes a batch of lists and regularJob() walks
// them one at a time with a download each, which is well outside the 5s debounce inside
// scheduleRestartDNSService(). The filter has been stale for hours by then, a minute more to
// collapse the batch is a good trade for not stopping DNS on every network N times in a row.
const BF_RESTART_DELAY = 60;
const DEFAULT_SECURITY_INTERVAL = 14400;
const DEFAULT_COUNTRY_INTERVAL = 86400;

class CategoryUpdateSensor extends Sensor {
  constructor(config) {
    super(config)

    // parts updateCategory() is currently working on, see getBfUpdateCallback(). Counted, not a
    // plain set: regularJob() and the Policy:CategoryActivated handler can be in the same part at
    // the same time, and the first one to finish must not drop the other's claim.
    this.inlineBfParts = new Map();
    // parts whose cloudcache callback was dropped because the part was claimed at the time
    this.bfPartsMissedUpdate = new Set();
    // categories waiting for a REFRESH_CATEGORY_FILTER, see scheduleCategoryFilterRefresh()
    this.pendingFilterRefresh = new Set();

    this.resetCategoryHashsetMapping()

    sem.on(Message.MSG_DEBUG, event => {
      if (event.name !== this.constructor.name) return;
      switch (event.data) {
        case 'regularJob':
          this.regularJob().catch(err => log.error('Failed to run regularJob', err)); break;
        case 'securityJob':
          this.securityJob().catch(err => log.error('Failed to run securityJob', err)); break;
        case 'countryJob':
          this.countryJob().catch(err => log.error('Failed to run countryJob', err)); break;
      }
    })
  }

  async regularJob() {
    try {
      const categories = Object.keys(this.categoryHashsetMapping)
      log.info('Native categories', categories);
      for (const category of categories) {
        await this.updateCategory(category);
      }
      await this.updateFlowSignatureList(true);
    } catch (err) {
      log.error("Failed to update categories", err)
    }
  }

  resetCategoryHashsetMapping() {
    this.categoryHashsetMapping = CategoryUpdater.getCategoryHashsetMapping();
  }

  async securityJob() {
    try {
      const securityCategories = Object.keys(securityHashMapping)
      log.info('Active security categories', securityCategories);
      for (const category of securityCategories) {
        await this.updateSecurityCategory(category)
      }
    } catch (err) {
      log.error("Failed to update security categories", err)
    }
  }

  async countryJob() {
    try {
      await this.renewCountryList();
      const activeCountries = countryUpdater.getActiveCountries();
      log.info('Active countries', activeCountries);
      for (const country of activeCountries) {
        await this.updateCountryAllocation(country)
        const category = countryUpdater.getCategory(country)
        await countryUpdater.refreshCategoryRecord(category)
        await countryUpdater.recycleIPSet(category)
      }
    } catch (err) {
      log.error("Failed to update conuntry sets", err)
    }
  }

  async getManagedTargetListInfo(category) {
    const infoHashsetId = `info:app.${category}`;
    try {
      const result = await bone.hashsetAsync(infoHashsetId);
      return JSON.parse(result);
    } catch (e) {
      log.error("Fail to fetch managed target list info:", category);
      return null;
    }
  }

  async updateCategory(category) {
    log.info(`Loading domains for ${category} from cloud`);

    // dnsmasq keeps using the bf content it loaded at startup, so any change to the data
    // files themselves needs a service restart rather than a config reload
    let bfDataChanged = false;
    // set when a part's data was deleted rather than rewritten, which is what tells
    // updateDnsmasqConfig() that an empty meta set means "gone", not "not written yet"
    let bfDataRemoved = false;
    const hashset = this.getCategoryHashset(category);

    let domains, info;
    if (category === "adblock_strict") {
      await categoryUpdater.updateStrategy(category, "adblock");
      info = {use_bf: true};
    } else if (categoryUpdater.isManagedTargetList(category)) {
      info = await this.getManagedTargetListInfo(category);
      log.debug(category, info);

      if (info && _.isObject(info) && (info.domain_count > 20000 || info.use_bf)) {
        await categoryUpdater.updateStrategy(category, "filter");
      } else {
        await categoryUpdater.updateStrategy(category, "default");
      }
    } else {
      await categoryUpdater.updateStrategy(category, "default");
    }

    let categoryStrategy = await categoryUpdater.getStrategy(category);

    if (!categoryStrategy.needOptimization) {
      // load user target list, enable port support
      if (categoryUpdater.isManagedTargetList(category)) {
        domains = await this.loadCategoryUsingCache(hashset);
      } else {
        domains = await this.loadCategoryFromBone(hashset);
      }
      if (domains == null) {
        log.error("Fail to fetch category list from cloud", category);
        return;
      }

      if (categoryUpdater.isUserTargetList(category) || categoryUpdater.isSmallExtendedTargetList(category) || (info && info.enable_v2))  {
        // in case of some categorys, such as doh, being converted to support tagret list with ports
        await categoryUpdater.flushDefaultDomains(category);
        await categoryUpdater.flushDefaultHashedDomains(category);
        await categoryUpdater.flushIPv4Addresses(category);
        await categoryUpdater.flushIPv6Addresses(category);
        await categoryUpdater.flushRegexDomains(category);
        // with port support
        await categoryUpdater.flushCategoryData(category);
        let categoryEntries = [];
        const regexEntries = [];
        let totalDomainPortCount = 0;
        let totalIpPortCount = 0;
        for (const item of domains) {
          try {
            log.debug("Parse category entry:", item);
            const entries = CategoryEntry.parse(item);
            log.debug("Category entries", entries);
            for (const entry of entries) {
              if (entry.type === "domain_re") {
                regexEntries.push(entry.id); // body
                continue;
              }
              if (entry.type === "domain") {
                totalDomainPortCount += entry.pcount;
              } else if (entry.type === "ipv4" || entry.type === "ipv6") {
                totalIpPortCount += entry.pcount;
              }
              categoryEntries.push(entry);
            }
          } catch (err) {
            log.error(err.message, item);
          }
        }
        log.debug(`Total domain port count: ${totalDomainPortCount}, total IP port count: ${totalIpPortCount}`);
        if (totalDomainPortCount > MAX_DOMAIN_PORT_COUNT  || totalIpPortCount > MAX_IP_PORT_COUNT) {
          log.error("Too much port match, disable category", category);
          categoryEntries = [];
        }
        await categoryUpdater.addCategoryData(category, categoryEntries);
        if (regexEntries.length > 0) {
          await categoryUpdater.addRegexDomains(category, regexEntries);
        }
      } else {
        // no port support
        // Peel off regex entries first so they don't get misclassified as domains by the Address4/6/hash filters below.
        const regexEntries = [];
        const ip4List = [];
        const ip6List = [];
        const hashDomains = [];
        const leftDomains = [];
        for (const d of domains) {
          if (typeof d === "string" && d.startsWith("regex:")) {
            try {
              const parsed = CategoryEntry.parse(d);
              for (const e of parsed) {
                if (e.type === "domain_re") regexEntries.push(e.id);
              }
            } catch (err) {
              log.error(err.message, d);
            }
          } else {
            const address4 = new Address4(d);
            if (address4.isValid()) {
              ip4List.push(d);
            } else {
              const address6 = new Address6(d);
              if (address6.isValid()) {
                ip6List.push(d);
              } else if (isHashDomain(d)) {
                hashDomains.push(d);
              } else {
                leftDomains.push(d);
              }
            }
          }
        }

        log.info(`category ${category} has ${ip4List.length} ipv4, ${ip6List.length} ipv6, ${leftDomains.length} domains, ${hashDomains.length} hashed domains, ${regexEntries.length} regex`);

        await categoryUpdater.flushDefaultDomains(category);
        await categoryUpdater.flushDefaultHashedDomains(category);
        await categoryUpdater.flushIPv4Addresses(category);
        await categoryUpdater.flushIPv6Addresses(category);
        await categoryUpdater.flushRegexDomains(category);

        if (leftDomains.length > 20000) {
          log.error(`Domain count too large. Disable category ${category} in normal strategy.`);
        } else {
          if (leftDomains && leftDomains.length > 0) {
            await categoryUpdater.addDefaultDomains(category, leftDomains, this.config.regularInterval * 2);
          }
        }
        if (hashDomains && hashDomains.length > 0) {
          await categoryUpdater.addDefaultHashedDomains(category, hashDomains);
        }
        if (ip4List && ip4List.length > 0) {
          await categoryUpdater.addIPv4Addresses(category, ip4List);
        }
        if (ip6List && ip6List.length > 0) {
          await categoryUpdater.addIPv6Addresses(category, ip6List);
        }
        if (regexEntries.length > 0) {
          await categoryUpdater.addRegexDomains(category, regexEntries);
        }
      }
      await this.removeData(category);

    } else {
      // this category need optimization
      await categoryUpdater.flushDefaultDomains(category);
      await categoryUpdater.flushDefaultHashedDomains(category);
      await categoryUpdater.flushIPv4Addresses(category);
      await categoryUpdater.flushIPv6Addresses(category);
      // Regex entries are not supported under filter/BF strategy. A regex target list should stay small enough
      // to remain on the default path;
      // if a list ever transitions from default to filter, flush any prior regex members so matchPolicy does not
      // keep matching stale entries after dnsmasq stops enforcing them.
      const prevRegex = await categoryUpdater.getRegexDomains(category);
      if (prevRegex && prevRegex.length > 0) {
        log.warn(`Category ${category} entered filter strategy with ${prevRegex.length} regex entries; regex enforcement will be disabled`);
      }
      await categoryUpdater.flushRegexDomains(category);

      if (!fc.isFeatureOn("category_filter")) {
        log.error(`Category filter feature not turned on. Category ${category} disabled.`);
        await categoryUpdater.updateStrategy(category, "default");
      } else {
        log.debug("Try to get filter data for category", category);
        if (!_.isObject(info)) {
          log.error(`Target list info of ${category} is unavailable, ignore it`);
          return;
        }
        // category may have multiple bloomfilter files, bf names are returned in "parts"
        const parts = _.isArray(info.parts) ? info.parts : [category];
        const prevParts = categoryUpdater.getCategoryBfParts(category);
        if (_.isEmpty(prevParts))
          prevParts.push(category); // this is for backward compatibility, parts is not supported before 1.981, so legacy data using category as bf name can be deleted if it is not included in parts now
        const removedParts = _.difference(prevParts, parts);
        log.info(`Current parts of category ${category} bf:`, parts);
        log.info(`Previous parts of category ${category} bf:`, prevParts);
        log.info(`Removed parts of category ${category} bf:`, removedParts);
        let updated = false;
        for (const part of removedParts) {
          const hashsetName = `bf:app.${part}`;
          await cloudcache.disableCache(hashsetName);
          if (await this.removeData(part).catch((err) => false)) {
            updated = true;
            bfDataChanged = true;
            bfDataRemoved = true;
          }
        }
        await categoryUpdater.setCategoryBfParts(category, parts);
        for (const part of parts) {
          const hashsetName = `bf:app.${part}`;
          const onUpdate = this.getBfUpdateCallback(category, part);
          // download() invokes the callback inline when it pulls new content, which would do the
          // same work this loop is about to do. Let the loop own the part while it is in here.
          this.claimBfPart(part);
          try {
            let currentCacheItem = cloudcache.getCacheItem(hashsetName);
            if (currentCacheItem) {
              // the item outlives this round, but the callback is only set by enableCache(), so
              // re-attach it here. Without it only the very first round of a part carries one and
              // the cloudcache job has no way to push a new filter out.
              currentCacheItem.onUpdate(onUpdate);
              await currentCacheItem.download();
            } else {
              log.debug("Add category data item to cloud cache:", part);
              await cloudcache.enableCache(hashsetName, onUpdate);
              // enableCache fires the callback once whether or not it downloaded anything, and
              // the claim above turned that into a missed-update mark. Nothing was missed: this
              // round reads the very content that callback carried, a few lines down.
              this.bfPartsMissedUpdate.delete(part);
              currentCacheItem = cloudcache.getCacheItem(hashsetName);
            }
            const content = await currentCacheItem.getLocalCacheContent();
            if (content) {
              const result = await this.updateData(part, content);
              bfDataChanged = bfDataChanged || result.dataChanged;
              updated = updated || result.dataChanged || result.metaChanged;
            } else {
              // remove obselete category data
              log.error(`Category ${category} part ${part} data is invalid. Remove it`);
              if (await this.removeData(part)) {
                bfDataChanged = true;
                bfDataRemoved = true;
                updated = true;
              }
            }
          } catch (e) {
            // break, not return: whatever the earlier parts already wrote to disk still has to
            // reach dnsmasq, otherwise a failure on one part strands the others' new data - and
            // worse, a part removed earlier in this round would stay in the conf as a path with
            // no file behind it. The cost is that a part that failed before its first download
            // is left out of the conf until the next round, which is the better of the two:
            // under-blocking one new part beats pointing dnsmasq at files that are gone.
            log.error(`Fail to update filter data for ${category}.`, e);
            break;
          } finally {
            this.releaseBfPart(part);
          }
          // a download landed while this round owned the part, so what the round applied above may
          // already be one version behind. Re-run against the current cache content; updateData()
          // is idempotent, so this is a no-op whenever the round did pick up the new copy. Leave
          // the mark alone if another round still owns the part - that one will consume it.
          if (this.bfPartsMissedUpdate.has(part) && !this.inlineBfParts.has(part)) {
            this.bfPartsMissedUpdate.delete(part);
            const item = cloudcache.getCacheItem(hashsetName);
            const latest = item ? await item.getLocalCacheContent() : null;
            // only content means "re-apply". A missed callback always carries content, so an empty
            // read here is a local glitch, not the cloud dropping the part - passing it on would
            // make applyBfUpdate() delete the data this round just wrote.
            if (latest) {
              log.info(`Re-applying bf part ${part} of category ${category}, a refresh landed mid-round`);
              await this.applyBfUpdate(category, part, latest).catch((err) => {
                log.error(`Failed to re-apply bf update of part ${part}`, err.message);
              });
            } else {
              log.warn(`Missed bf refresh of part ${part} but its cache content is unreadable, skip`);
            }
          }
        }
        if (updated) {
          this.scheduleCategoryFilterRefresh(category);
        } else {
          log.debug("Skip sending REFRESH_CATEGORY_FILTER event");
        }

        const ipList = await this.loadCategoryFromBone(`ip:app.${category}`);
        if (ipList && ipList.length > 0) {
          const ip4List = ipList.filter(d => new Address4(d).isValid());
          const ip6List = ipList.filter(d => new Address6(d).isValid());
          log.info(`category ${category} 'bf' IP list has ${ip4List.length} ipv4 addr, ${ip6List.length} ipv6 addr`);
          if (ip4List.length > 0)
            await categoryUpdater.addIPv4Addresses(category, ip4List);
          if (ip6List.length > 0)
            await categoryUpdater.addIPv6Addresses(category, ip6List);
        }
      }
    }

    await this.updateDnsmasqConfig(category, bfDataChanged, bfDataRemoved);

    const event = {
      type: "UPDATE_CATEGORY_DOMAIN",
      category,
      message: category,
    };
    sem.sendEventToAll(event);
  }

  // cloudcache refreshes every registered item every 3 hours, but without a callback a new bf only
  // lands in the data file and in redis on the next updateCategory(), i.e. up to 8 hours later
  // (regularInterval). This closure is what turns a cloudcache download into an immediate update.
  getBfUpdateCallback(category, part) {
    return (content) => {
      // updateCategory() is already handling this part and will do the same work inline. Record
      // it though: the round may have read the cache content before this download replaced it,
      // in which case it applies the older copy and cloudcache never calls back again (it only
      // does so when it writes new content), stranding the new filter until the next regularJob.
      if (this.inlineBfParts.has(part)) {
        this.bfPartsMissedUpdate.add(part);
        return;
      }
      this.applyBfUpdate(category, part, content).catch((err) => {
        log.error(`Failed to apply bf update of part ${part} for category ${category}`, err.message);
      });
    };
  }

  claimBfPart(part) {
    this.inlineBfParts.set(part, (this.inlineBfParts.get(part) || 0) + 1);
  }

  releaseBfPart(part) {
    const claims = (this.inlineBfParts.get(part) || 0) - 1;
    if (claims > 0)
      this.inlineBfParts.set(part, claims);
    else
      this.inlineBfParts.delete(part);
  }

  scheduleBfRestart() {
    if (this.bfRestartTask)
      clearTimeout(this.bfRestartTask);
    this.bfRestartTask = setTimeout(() => {
      delete this.bfRestartTask;
      // ignoreFileCheck as well: the generated conf carries only <path,size,error> and stays
      // byte-identical when a filter is rebuilt with the same entry count
      dnsmasq.scheduleRestartDNSService(true, true);
    }, BF_RESTART_DELAY * 1000);
  }

  // Every part of a category used to share one event per updateCategory() round; now that parts
  // refresh independently, emitting per part would run CategoryExaminerPlugin.refreshCategoryFilter()
  // once per part - and that walks the whole hit/passthrough set with an intelproxy call per
  // domain. Collapse them back to one event per category.
  scheduleCategoryFilterRefresh(category) {
    this.pendingFilterRefresh.add(category);
    if (this.filterRefreshTask)
      return;
    this.filterRefreshTask = setTimeout(() => {
      delete this.filterRefreshTask;
      const categories = Array.from(this.pendingFilterRefresh);
      this.pendingFilterRefresh.clear();
      for (const c of categories) {
        sem.emitEvent({
          type: "REFRESH_CATEGORY_FILTER",
          category: c,
          toProcess: "FireMain"
        });
      }
    }, 5000);
  }

  async applyBfUpdate(category, part, content) {
    // a part can be reassigned to another category while this callback stays attached to the
    // cache item, so trust the current mapping over the one captured when it was created
    const owner = categoryUpdater.getCategoryByBfPart(part) || category;
    // updateCategory() can drop a part while cloudcache is downloading it, and the part-to-category
    // mapping keeps removed parts. Applying that late download would put the data file and its meta
    // back for a part no round will ever list as removed again, so they would never be cleaned up.
    if (!categoryUpdater.getCategoryBfParts(owner).includes(part)) {
      log.info(`Part ${part} is no longer a part of category ${owner}, ignore its bf update`);
      return;
    }
    // Category:Delete drops the category and its dnsmasq config but leaves the bf cache item
    // registered, so this callback outlives the category it was created for. Without this check
    // the next filter the cloud publishes would recreate the conf of a target list the user
    // deleted - and force a dnsmasq restart to put it back into service. Both structures below
    // are what that handler clears; a native category with no rule behind it is in neither
    // activeCategories nor deleted, which is why the hashset mapping is checked too.
    if (!categoryUpdater.isActivated(owner) && !this.categoryHashsetMapping[owner]) {
      log.info(`Category ${owner} is gone, ignore bf update of part ${part}`);
      return;
    }
    const strategy = await categoryUpdater.getStrategy(owner);
    if (!_.get(strategy, "dnsmasq.useFilter")) {
      log.info(`Category ${owner} no longer uses a bloom filter, ignore update of part ${part}`);
      return;
    }

    if (!content) {
      // cloudcache gives up on the item: expired, or never served by the cloud at all. The latter
      // repeats on every job round, so only act when there was something left to remove.
      if (!await this.removeData(part))
        return;
      log.error(`Bf data of part ${part} of category ${owner} is gone, removed it`);
      this.scheduleCategoryFilterRefresh(owner);
      await this.updateDnsmasqConfig(owner, true, true);
      return;
    }

    const { dataChanged, metaChanged } = await this.updateData(part, content);
    if (!dataChanged && !metaChanged)
      return;

    log.info(`Bf part ${part} of category ${owner} refreshed by cloudcache, data changed: ${dataChanged}`);
    this.scheduleCategoryFilterRefresh(owner);
    await this.updateDnsmasqConfig(owner, dataChanged);
  }

  // returns { dataChanged, metaChanged }:
  //   dataChanged - the bf data file on disk was replaced. dnsmasq only picks up new bf content
  //                 on a full service restart (it caches the filter per file path for the lifetime
  //                 of the process and never re-reads it on a config reload), so this is what
  //                 decides whether we pay for a restart.
  //   metaChanged - the meta in redis was (re)written, which is all intelproxy needs to reload.
  async updateData(category, content) {
    log.debug("Update category filter data", category);
    const unchanged = { dataChanged: false, metaChanged: false };
    const obj = JSON.parse(content);
    if (!obj.data || !obj.info) {
      return unchanged;
    }

    const filterFile = `${categoryUpdater.getCategoryFilterDir()}/${category}.data`;
    const uid = `category:${category}`;
    const meta = {
      uid: uid,
      size: obj.info.s,
      error: obj.info.e,
      checksum: obj.info.checksum,
      path: `${category}.data`
    };

    const buf = Buffer.from(obj.data, "base64");

    // verify the checksum locally instead of trusting the cloud one. intelproxy md5s the data file
    // against this checksum, so a mismatching pair here would silently disable the filter on its side
    const actualChecksum = crypto.createHash('md5').update(buf).digest('hex');
    if (meta.checksum && actualChecksum !== meta.checksum) {
      log.error(`Checksum mismatch in bf data of ${category}, expect ${meta.checksum}, got ${actualChecksum}, skip`);
      return unchanged;
    }

    // the cloudcache job and updateCategory() can both land here for the same part, and they
    // share the temp file path, so serialize per part
    return lock.acquire(`${LOCK_BF_DATA}:${category}`, async () => {
      let currentFileContent;
      try {
        currentFileContent = await readFileAsync(filterFile);
      } catch (e) {
        currentFileContent = null;
      }

      let dataChanged = false;
      if (currentFileContent && buf.equals(currentFileContent)) {
        // the data file is already up to date, but the meta in redis may have fallen behind, e.g. a
        // previous round wrote the file and then failed on hset. don't skip until both halves agree,
        // otherwise the pair stays out of sync forever and intelproxy keeps failing the checksum
        const currentMeta = await rclient.hgetAsync(CATEGORY_DATA_KEY, uid).then(r => r && JSON.parse(r)).catch(err => null);
        if (_.isEqual(currentMeta, meta)) {
          log.debug(`No filter update for ${category}, skip`);
          return { dataChanged: false, metaChanged: false };
        }
        log.warn(`Filter data of ${category} is up to date but its meta in redis is stale, repairing`, currentMeta);
      } else {
        // write to a temp file and rename, so intelproxy never reads a partially written data file
        const tmpFile = `${filterFile}.tmp.${process.pid}`;
        try {
          await writeFileAsync(tmpFile, buf);
          await renameAsync(tmpFile, filterFile);
        } catch (err) {
          await unlinkAsync(tmpFile).catch(() => undefined);
          throw err;
        }
        dataChanged = true;
      }

      await rclient.hsetAsync(CATEGORY_DATA_KEY, uid, JSON.stringify(meta));

      const updateEvent = {
        type: "update",
        msg: {
          uid: uid
        }
      };
      await rclient.publishAsync(INTEL_PROXY_CHANNEL, JSON.stringify(updateEvent));
      return { dataChanged, metaChanged: true };
    });
  }

  // returns true if anything was actually removed. Callers use it to tell a real change from a
  // repeated no-op: cloudcache keeps calling back for a part the cloud does not serve, and
  // forcing a dnsmasq restart on every one of those rounds is exactly what this feature avoids.
  async removeData(category) {
    log.debug("Remove category filter data", category);
    const uid = `category:${category}`;
    const filterFile = `${categoryUpdater.getCategoryFilterDir()}/${category}.data`;
    // same lock as updateData(), so a removal can't land between its rename and its hset and
    // leave redis pointing at a data file that is gone
    return lock.acquire(`${LOCK_BF_DATA}:${category}`, async () => {
      const metaRemoved = await rclient.hdelAsync(CATEGORY_DATA_KEY, uid);
      const fileRemoved = await unlinkAsync(filterFile).then(() => true).catch((err) => {
        if (err.code !== 'ENOENT')
          log.error(`Failed to remove filter data of ${category}`, err.message);
        return false;
      });
      return Boolean(metaRemoved) || fileRemoved;
    });
  }

  async updateDnsmasqConfig(category, bfDataChanged = false, bfDataRemoved = false) {
    // the parts of a multi-part category (porn_bf, intel_bf and allcat_bf each have a base and a
    // diff part) refresh independently and their cloudcache callbacks land here concurrently,
    // while writeConfig() truncates in place: two overlapping writes of different lengths can
    // leave a fragment of the longer one behind, which dnsmasq then fails to parse on restart
    return lock.acquire(`${LOCK_BF_CONF}:${category}`, async () => {
      const strategy = await categoryUpdater.getStrategy(category);
      if (strategy.dnsmasq.useFilter) {
        const parts = categoryUpdater.getCategoryBfParts(category);
        const meta = {};
        for (const part of parts) {
          const key = `category:${part}`;
          const partMeta = await rclient.hgetAsync(CATEGORY_DATA_KEY, key);
          if (partMeta)
            meta[part] = JSON.parse(partMeta);
          else
            log.error(`No bf data found for part ${part} of category ${category}`);
        }
        if (!_.isEmpty(meta)) {
          await dnsmasq.createCategoryFilterMappingFile(category, meta);
        } else if (_.isEmpty(parts) || bfDataRemoved) {
          // Nothing left to point at. Leaving the entry would keep <path,size,error> for a file
          // that no longer exists, and on the next restart dnsmasq's mmap of it fails and every
          // instance falls back to its own full-size empty filter - the very memory the shared
          // mapping was introduced to save. Nothing retries either: once the cloud withdraws a
          // list, updateCategory() returns on the missing target list info before it gets here.
          log.error(`No bf data. Delete dns filter config for category: ${category}`);
          await dnsmasq.deletePolicyCategoryFilterEntry(category);
        } else {
          // Parts are registered but none of them has its meta in redis, and nothing reported a
          // removal: this is a concurrent round caught between setCategoryBfParts() and the first
          // updateData() of its new parts. Deleting the config here would stop enforcing the
          // category until that round finishes, so keep what dnsmasq already has.
          log.warn(`No bf meta for any part of category ${category}, keep current dns filter config`);
        }
      } else {
        await dnsmasq.createCategoryMappingFile(category, [categoryUpdater.getIPSetName(category), `${categoryUpdater.getIPSetNameForIPV6(category)}`]);
      }
      // A config reload makes dnsmasq re-read these conf files, but not the bf data they point at:
      // it keeps one filter per file path for the lifetime of the process and reuses it on every
      // reload, so new bf content only takes effect on a full service restart. Anything else is
      // a conf-only change and the usual reload path handles it.
      if (bfDataChanged)
        this.scheduleBfRestart();
      else
        dnsmasq.scheduleRestartDNSService();
    });
  }

  async updateSecurityCategory(category) {
    log.info(`Loading security info for ${category} from cloud`);

    const hashset = securityHashMapping[category]
    const info = await this.loadCategoryFromBone(hashset);
    if (info == null) return

    const domains = info.domain
    const ip4List = info["ip4"]
    const ip6List = info["ip6"]

    const domainOnly = info["domainOnly"]
    const hashedDomains = info["hashedDomains"]

    log.info(`category ${category} has ${(ip4List || []).length} ipv4,`
      + ` ${(ip6List || []).length} ipv6, ${(domains || []).length} domains,`
      + ` ${(domainOnly || []).length} domainOnly, ${(hashedDomains || []).length} hashedDomains,`)

    await categoryUpdater.flushDefaultDomainsOnly(category);
    await categoryUpdater.flushDefaultHashedDomains(category);
    await categoryUpdater.flushDefaultDomains(category);
    await categoryUpdater.flushIPv4Addresses(category)
    await categoryUpdater.flushIPv6Addresses(category)
    if (domainOnly && domainOnly.length > 0) {
      await categoryUpdater.addDefaultDomainsOnly(category, domainOnly, this.config.securityInterval * 2);
    }

    if (hashedDomains && hashedDomains.length > 0) {
      await categoryUpdater.addDefaultHashedDomains(category, hashedDomains);
    }

    if (domains && domains.length > 0) {
      await categoryUpdater.addDefaultDomains(category, domains, this.config.securityInterval * 2);
    }

    if (ip4List && ip4List.length > 0) {
      await categoryUpdater.addIPv4Addresses(category, ip4List)
    }

    if (ip6List && ip6List.length > 0) {
      await categoryUpdater.addIPv6Addresses(category, ip6List)
    }

    const event = {
      type: "UPDATE_CATEGORY_DOMAIN",
      category,
      message: category,
    };
    sem.sendEventToAll(event);
  }

  async updateCountryAllocation(country) {
    const category = countryUpdater.getCategory(country);
    log.info(`Loading country ip allocation list for ${country} from cloud`);

    const ip4List = await this.loadCategoryFromBone(category + ':ip4');

    if (ip4List) {
      await countryUpdater.addAddresses(country, false, ip4List)
    }

    log.info(`Country ${country} has ${(ip4List || []).length} ipv4 entries`);

    if (fc.isFeatureOn('ipv6')) {
      const ip6List = await this.loadCategoryFromBone(category + ':ip6');

      if (ip6List) {
        await countryUpdater.addAddresses(country, true, ip6List)
      }

      log.info(`Country ${country} has ${(ip6List || []).length} ipv6 entries`)
    }
  }

  run() {
    void execSync(`mkdir -p ${categoryUpdater.getCategoryFilterDir()}`);

    sem.once('IPTABLES_READY', async () => {
      // initial round of country list update is triggered by this event
      // also triggers dynamic list and ipset update here
      // to make sure blocking takes effect immediately
      sem.on('Policy:CountryActivated', async (event) => {
        try {
          await this.updateCountryAllocation(event.country)
          const category = countryUpdater.getCategory(event.country)
          await countryUpdater.refreshCategoryRecord(category)
          await countryUpdater.recycleIPSet(category, false)
        } catch (err) {
          log.error("Failed to update conuntry set", event.country, err)
        }
        countryUpdater.markAttempted(countryUpdater.getCategory(event.country))
      });

      sem.on('Policy:CategoryActivated', async (event) => {
        const category = event.category;
        const reloadFromCloud = event.reloadFromCloud;
        if (reloadFromCloud !== false && !categoryUpdater.isCustomizedCategory(category)) {
          try {
            if (securityHashMapping.hasOwnProperty(category)) {
              await this.updateSecurityCategory(category);
            } else {
              const categories = Object.keys(this.categoryHashsetMapping);
              if (!categories.includes(category)) {
                this.categoryHashsetMapping[category] = `app.${category}`;
              }
              await this.updateCategory(category);
            }
          } catch (err) {
            log.error("Failed to update category", category, err.message);
          }
        } else {
          // only send UPDATE_CATEGORY_DOMAIN event for customized category or reloadFromCloud is false, which will trigger ipset/tls set refresh in CategoryUpdater.js
          const event = {
            type: "UPDATE_CATEGORY_DOMAIN",
            category,
            message: category,
          };
          sem.sendEventToAll(event);
        }
        // the initial load attempt has settled, successfully or not. don't hold up the initial
        // iptables/ipset restore any longer; on failure the category keeps whatever data redis
        // already had, and the next periodic update retries the fetch
        categoryUpdater.markAttempted(category);
      });

      sem.on('Categorty:ReloadFromBone', (event) => {
        const category = event.category;
        if (!categoryUpdater.isCustomizedCategory(category) &&
          (categoryUpdater.isActivated(category) || categoryUpdater.isTLSActivated(category))) {
          sem.emitEvent({
            type: "Policy:CategoryActivated",
            toProcess: "FireMain",
            message: "Category ReloadFromBone: " + category,
            category: category,
            reloadFromCloud: true
          });
        }
      });

      // deciding whether a user target list still has a rule/exception behind it needs state that
      // only exists in this process, so FireApi/FireMon delegate the check here
      sem.on('Category:MaybeDeactivate', async (event) => {
        await exceptionManager.maybeDeactivateCategory(event.category).catch((err) => {
          log.error("Failed to check category deactivation", event.category, err.message);
        });
      })

      sem.on('Category:Delete', async (event) => {
        log.info("Deactivate category", event.category);
        const category = event.category;
        await categoryUpdater.clearRecycleTask(category);
        if (!categoryUpdater.isCustomizedCategory(category) &&
          categoryUpdater.activeCategories[category]) {
          // user target lists are loaded through cloudcache, whose own job keeps refreshing
          // registered items regardless of whether the category is still active
          const hashset = this.getCategoryHashset(category);
          if (hashset && categoryUpdater.isUserTargetList(category))
            await cloudcache.disableCache(hashset);
          delete categoryUpdater.activeCategories[category];
          delete this.categoryHashsetMapping[category];
          await categoryUpdater.flushDefaultDomains(category);
          await categoryUpdater.flushDefaultHashedDomains(category);
          await categoryUpdater.flushIPv4Addresses(category);
          await categoryUpdater.flushIPv6Addresses(category);
          await categoryUpdater.flushRegexDomains(category);
          await dnsmasq.deletePolicyCategoryFilterEntry(category);
          // handle related ipset?
        }
      })

      // this flushes all category related stuff, including customized category and country
      sem.on('Category:Flush', async () => {
        try {
          categoryUpdater.resetUpdaterState()
          countryUpdater.resetActiveCountries()
          this.resetCategoryHashsetMapping()

          const categoryKeys = (await rclient.scanResults('category:*'))
            .concat(await rclient.scanResults('dynamicCategoryDomain:*'))
            .concat(await rclient.scanResults('dynamicCategory:*'))     // country
            .concat(await rclient.scanResults('customized_category:*')) // qos
          categoryKeys.length && await rclient.unlinkAsync(categoryKeys)

          await dnsmasq.flushCategoryFilters()

          log.info('Category:Flush done')
        } catch (err) {
          log.error('Failed flushing', err)
        }
      })

      await this.regularJob()
      await this.securityJob()
      await this.renewCountryList()

      setInterval(this.regularJob.bind(this), (this.config.regularInterval || DEFAULT_REGULAR_INTERVAL) * 1000)

      setInterval(this.securityJob.bind(this), (this.config.securityInterval || DEFAULT_SECURITY_INTERVAL) * 1000)

      setInterval(this.countryJob.bind(this), (this.config.countryInterval || DEFAULT_COUNTRY_INTERVAL) * 1000)

      sem.emitLocalEvent({
        type: "CategoryUpdateSensorReady",
      });
    })
  }

  async loadCategoryFromBone(hashset) {
    if (hashset) {
      let data
      try {
        data = await bone.hashsetAsync(hashset)
        const list = JSON.parse(data)
        return list
      } catch (err) {
        log.error("Failed to get hashset", err.message);
        return null;
      }
    } else {
      return null
    }
  }

  async loadCategoryUsingCache(hashsetId) {
    if (!hashsetId) {
      return null;
    }
    try {
      let item = cloudcache.getCacheItem(hashsetId);
      let r;
      if (!item) {
        r = await cloudcache.enableCache(hashsetId);
        item = cloudcache.getCacheItem(hashsetId);
      } else {
        r = await item.download();
      }
      if (r) {
        const data = await item.getLocalCacheContent();
        return JSON.parse(data);
      } else {
        log.info(`No local and remote checksum for category ${hashsetId}, disable cloud cache`);
        return (await this.loadCategoryFromBone(hashsetId));
      }
    } catch (err) {
      log.error(`Fail to load category hashset`, hashsetId, err);
      return null;
    }
  }

  getCategoryHashset(category) {
    return this.categoryHashsetMapping[category]
  }

  async renewCountryList() {
    const countryList = await this.loadCategoryFromBone('country:list');
    if (countryList == null) return

    await rclient.unlinkAsync('country:list');
    if (countryList.length) {
      await rclient.saddAsync('country:list', countryList);
    }
  }

  async updateFlowSignatureList(forceReload = false) {
    const pervFlowSignatureConfig = this.flowSignatureConfig || {};
    let flowSignatureConfig = await rclient.getAsync(Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG).then(result => result && JSON.parse(result)).catch(err => null);
    this.flowSignatureConfig = flowSignatureConfig;
    if (_.isEmpty(flowSignatureConfig) || forceReload) {
      flowSignatureConfig = await bone.hashsetAsync(Constants.REDIS_KEY_FLOW_SIGNATURE_CONFIG).then(result => result && JSON.parse(result)).catch((err) => null);
      if (!_.isEmpty(flowSignatureConfig) && _.isObject(flowSignatureConfig)) {
        await rclient.setAsync(Constants.REDIS_KEY_FLOW_SIGNATURE_CLOUD_CONFIG, JSON.stringify(flowSignatureConfig));
        this.flowSignatureConfig = flowSignatureConfig;
      }
    }
    if (this.flowSignatureConfig && !_.isEqual(pervFlowSignatureConfig, this.flowSignatureConfig)){
      sem.emitEvent({
        type: "FlowSignatureListUpdated",
        toProcess: "FireMain"
      });
    }
  }

}

module.exports = CategoryUpdateSensor;
