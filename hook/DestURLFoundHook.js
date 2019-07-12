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

const log = require('../net2/logger.js')(__filename, 'info');

const Hook = require('./Hook.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()

const f = require("../net2/Firewalla.js")

const Promise = require('bluebird');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const flowUtil = require('../net2/FlowUtil.js');

const sl = require('../sensor/SensorLoader.js');

const urlhash = require("../util/UrlHash.js");

const URL_SET_TO_BE_PROCESSED = "url_set_to_be_processed";

const ITEMS_PER_FETCH = 100;
const QUEUE_SIZE_PAUSE = 2000;
const QUEUE_SIZE_RESUME = 1000;

const TRUST_THRESHOLD = 10 // to be updated

const MONITOR_QUEUE_SIZE_INTERVAL = 10 * 1000; // 10 seconds;

const CommonKeys = require('../net2/CommonKeys.js');

const _ = require('lodash');

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

class DestURLFoundHook extends Hook {

  constructor() {
    super();

    this.config.intelExpireTime = 2 * 24 * 3600; // two days
    this.pendingIPs = {};
  }

  appendURL(url) {
    const info = {url};
    return rclient.zaddAsync(URL_SET_TO_BE_PROCESSED, 0, JSON.stringify(info));
  }

  isFirewalla(host) {
    let patterns = [/\.encipher\.io$/,
      /^encipher\.io$/,
      /^firewalla\.com$/,
      /\.firewalla\.com$/];

    return patterns.filter(p => host.match(p)).length > 0;
  }

  getSubURLWithHashes(url) {
    const hashes = urlhash.canonicalizeAndHashExpressions(url);
    return hashes;
  }

  async alreadyEnriched(subURL) {
    const intel = await intelTool.getURLIntel(subURL);
    return intel != null;
  }

  async processURL(url, options) {
    options = options || {};

    const skipReadLocalCache = options.skipReadLocalCache;

    const subURLHashes = this.getSubURLWithHashes(url);

    const urlsNeedCheck = [];

    // find out if any url or sub urls requires validation
    for(const subURLHash of subURLHashes) {
      if(subURLHash.constructor.name !== 'Array' ||
      subURLHash.length !== 3) {
        continue;
      }

      const url = subURLHash[0];

      const safe = await this.isUrlSafe(url);

      if(safe) {
        continue;
      }

      if(!skipReadLocalCache) {
        const existing = await this.alreadyEnriched(url);
        if(existing) {
          continue;
        }
      }

      urlsNeedCheck.push(subURLHash);
    }

    if(urlsNeedCheck.length > 0) {
      let results = await intelTool.checkURLIntelFromCloud(urlsNeedCheck);

      if(!results) {
         return;
      }

      // only focus on intels
      results = results.filter((result) => result.c === 'intel');

      const safeURLs = urlsNeedCheck.filter((urlNeedCheck) => {
        const matchedResults = results.filter((result) => result.ip && urlNeedCheck[2] && result.ip === urlNeedCheck[2]);
        // if this url matches no result from cloud, consider as safe urls
        return _.isEmpty(matchedResults);
      }).map((urlNeedCheck) => urlNeedCheck[0]);

      for(const safeURL of safeURLs) {
        await this.markAsSafe(safeURL);
      }

      if(!_.isEmpty(results)) {
        await this.storeIntels(urlsNeedCheck, results);
      }
    }
  }

  async _storeIntel(url, result) {
    const normalized = this.normalizeIntelResult(url, result);
    if(normalized) {
      await intelTool.addURLIntel(url, normalized, this.config.intelExpireTime);
    }
  }

  normalizeIntelResult(url, result) {
    if(!result) {
      return null;
    }

    const copy = JSON.parse(JSON.stringify(result));
    copy.url = url;
    if(copy.c) {
      copy.category = copy.c;
      delete copy.c;            
    }

    if("flowid" in copy) delete copy.flowid;
    if("ip" in copy) delete copy.ip;
    if("ts" in copy) delete copy.ts;

    return copy;
  }

  findURLByHash(hash, urlsWithHash) {
    for(const urlWithHash of urlsWithHash) {
      if(urlWithHash && urlWithHash.length === 3 && urlWithHash[2] === hash) {
        return urlWithHash[0];
      }
    }

    return null;
  }

  async storeIntels(urlsNeedCheck, results) {
    for(const result of results) {
      const hash = result && result.ip;
      if(!hash) {
        continue;
      }

      const url = this.findURLByHash(hash, urlsNeedCheck);
      if(!url) {
        continue;
      }

      await this._storeIntel(url, result);
    }    
  }

  async markAsSafe(subURL) {
    await rclient.zaddAsync(CommonKeys.intel.safe_urls, new Date() / 1000, subURL);
    await intelTool.removeURLIntel(subURL);
  }

  async isUrlSafe(subURL) {
    const score = await rclient.zscoreAsync(CommonKeys.intel.safe_urls, subURL);
    return score !== null;
  }

  async job() {
    log.debug("Checking if any urls pending for intel analysis...")

    try {
      let urls = await rclient.zrangeAsync(URL_SET_TO_BE_PROCESSED, 0, ITEMS_PER_FETCH);

      if(urls.length > 0) {
        const cachePlugin = sl.getSensor("IntelLocalCachePlugin");

	      let filteredURLs = urls.map((urlJSON) => {
          try {
            const urlData = JSON.parse(urlJSON);
            return urlData.url;
          } catch(err) {
            return null;
          }
        }).filter((url) => url !== null);

        if(cachePlugin) {
          filteredURLs = filteredURLs.filter((url) => {
            const subURLHashes = this.getSubURLWithHashes(url);
            return subURLHashes.some((hash) => {
              if(_.isEmpty(hash) || hash.length !== 3) {
                return false;
              }
              return cachePlugin.checkUrl(hash[0]);
            });
          });
        }

        const promises = filteredURLs.map((url) => this.processURL(url).catch((err) => {
          log.error(`Got error when handling url ${url}, err: ${err}`);
        }));

        await Promise.all(promises);

        const args = [URL_SET_TO_BE_PROCESSED];
        args.push.apply(args, urls);

        if(args.length > 1) {
          await rclient.zremAsync(args);
        }

        log.debug(urls.length + "URLs are analyzed with intels");

      } else {
        // log.info("No IP Addresses are pending for intels");
      }
    } catch(err) {
      log.error("Got error when handling new URL, err:", err)
    }

    setTimeout(() => {
      this.job(); // sleep for only 500 mill-seconds
    }, 1000);
  }

  run() {
    sem.on('DestURLFound', (event) => {
      const url = event.url;
      this.appendURL(url);
    });

    sem.on('DestURL', (event) => {
      const skipReadLocalCache = event.skipReadLocalCache;
      this.processURL(event.url, {skipReadLocalCache});
    })

    this.job();

    setInterval(() => {
      this.monitorQueue()
    }, MONITOR_QUEUE_SIZE_INTERVAL)
  }

  async monitorQueue() {
    let count = await rclient.zcountAsync(URL_SET_TO_BE_PROCESSED, "-inf", "+inf")
    if(count > QUEUE_SIZE_PAUSE) {
      this.paused = true;
    }
    if(count < QUEUE_SIZE_RESUME) {
      this.paused = false;
    }
  }
}

module.exports = DestURLFoundHook;
