/*    Copyright 2016-2020 Firewalla Inc.
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

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const DestIPFoundHook = require('../hook/DestIPFoundHook');
const destIPFoundHook = new DestIPFoundHook();

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const MAX_RECENT_INTERVAL = 24 * 60 * 60; // one day
const MAX_RECENT_LOG = 100;

const Promise = require('bluebird');

const _ = require('lodash');

class LogQuery {

  // override this
  mergeLog(result, incoming) {
    throw new Error('not implemented')
  }

  shouldMerge(previous, incoming) {
    throw new Error('not implemented')
  }

  // logs should already be sorted
  // adds a minimal merge time span so logs 
  mergeLogs(logs, options) {
    if (options.no_merge) return logs

    let mergedLogs = [];
    let lastLog = null;

    logs.forEach(entry => {
      if (!lastLog || !this.shouldMerge(lastLog, entry)) {
        mergedLogs.push(entry);
        lastLog = entry;
      } else {
        this.mergeLog(lastLog, entry);
      }
    });

    return mergedLogs;
  }

  stringToJSON(string) {
    try {
      return JSON.parse(string);
    } catch(err) {
      log.debug('Failed to parse log', string)
      return null;
    }
  }

  // override this
  isLogValid(log) {
    if (!log) return false

    return true
  }

  // override this
  // convert to a simplified json format that's more readable by app
  toSimpleFormat(entry) {
    return entry
  }

  validResultCount(options, results, feed) {
    const safeIndex = results.findIndex(l => options.asc ? l.ts > feed.ts : l.ts < feed.ts)

    return safeIndex == -1 ? results.length : safeIndex
  }

  /**
   * @param {Object} options - common options for all feeds
   * @param {Object[]} feeds - feeds of logs
   * @param {function} feeds[].query - function that gets log
   * @param {Object} feeds[].options - unique options for the query
   */
  async logFeeder(options, feeds) {
    options = this.checkArguments(options)
    feeds.forEach(f => {
      f.options = f.options || {}
      Object.assign(f.options, options)
    })
    let results = []

    // always query the feed moves slowest
    let feed = options.asc ? _.minBy(feeds, 'options.ts') : _.maxBy(feeds, 'options.ts')

    while (this.validResultCount(options, results, feed) < options.count && feeds.length) {

      const logs = await feed.query(feed.options)
      if (logs.length) {
        feed.options.ts = logs[logs.length - 1].ts
      } else {
        // no more elements, remove feed from feeds
        feeds = feeds.filter(f => f != feed)
      }

      while (logs.length) results.push(logs.shift());

      results.sort((a, b) => options.asc ? a.ts - b.ts : b.ts - a.ts )
      results = this.mergeLogs(results, options);

      feed = options.asc ? _.minBy(feeds, 'options.ts') : _.maxBy(feeds, 'options.ts')
    }

    return results
  }

  checkArguments(options) {
    options = options || {}
    if (!options.count || options.count > MAX_RECENT_LOG) options.count = MAX_RECENT_LOG
    if (!options.asc) options.asc = false;
    if (!options.ts) {
      options.ts = (options.asc ? options.begin : options.end) || new Date() / 1000;
    }
    if (!options.ets) {
      options.ets = options.asc ?
        (options.end || options.ts + MAX_RECENT_INTERVAL) :
        (options.begin || options.ts - MAX_RECENT_INTERVAL)
    }

    return options
  }

  // get logs across different devices
  async getAllLogs(options) {

    options = this.checkArguments(options)

    const HostManager = require("../net2/HostManager.js");
    const hostManager = new HostManager();

    let allMacs = [];
    if (options.mac) {
      allMacs = [ options.mac ]
    } else if (options.intf) {
      if (!_.isArray(options.macs) || options.macs.length === 0) {
        const HostManager = require("../net2/HostManager.js");
        const hostManager = new HostManager();
        allMacs = hostManager.getIntfMacs(options.intf);
      } else {
        allMacs = options.macs;
      }
    } else if (options.tag) {
      allMacs = hostManager.getTagMacs(options.tag);
    } else {
      allMacs = await hostTool.getAllMACs();
      if (_.isArray(options.macs))
        allMacs = _.uniq(allMacs.concat(options.macs));
    }

    let allLogs = [];

    await Promise.all(allMacs.map(async mac => {
      const optionsCopy = JSON.parse(JSON.stringify(options)) // get a clone to avoid side impact to other functions

      const logs = await this.getDeviceLogs(mac, optionsCopy);

      while (logs.length) allLogs.push(logs.shift());
    }));

    allLogs = _.orderBy(allLogs, 'ts', options.asc ? 'asc' : 'desc');
    allLogs = this.mergeLogs(allLogs, options);

    allLogs = await this.enrichWithIntel(allLogs);

    return allLogs;
  }


  async enrichWithIntel(logs) {
    return await Promise.map(logs, async f => {
      // get intel from redis. if failed, create a new one
      const intel = await intelTool.getIntel(f.ip);

      if (intel) {
        f.country = intel.country;
        f.host = intel.host;
        if(intel.category) {
          f.category = intel.category
        }
        if(intel.app) {
          f.app = intel.app
        }
      }

      // failed on previous cloud request, try again
      if (intel && intel.cloudFailed || !intel) {
        // not waiting as that will be too slow for API call
        destIPFoundHook.processIP(f.ip);
      }

      return f;
    }, {concurrency: 10}); // limit to 10
  }

  // override this
  getLogKey(target, options) {
    throw new Error('not implemented')
  }

  async getDeviceLogs(target, options) {
    options = this.checkArguments(options)

    const key = this.getLogKey(target, options);

    const zrange = (options.asc ? rclient.zrangebyscoreAsync : rclient.zrevrangebyscoreAsync).bind(rclient);
    const results = await zrange(key, '(' + options.ts, options.ets, "LIMIT", 0 , options.count);

    if(results === null || results.length === 0)
      return [];

    const logObjects = results
      .map(x => this.stringToJSON(x))
      .filter(x => this.isLogValid(x));

    const simpleLogs = logObjects
      .map((f) => {
        let s = this.toSimpleFormat(f)
        s.device = target; // record the mac address here
        return s;
      });

    return simpleLogs
  }
}

module.exports = LogQuery;
