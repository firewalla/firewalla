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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const BloomFilter = require('../vendor_lib/bloomfilter.js').BloomFilter;

const urlhash = require("../util/UrlHash.js");

const f = require('../net2/Firewalla.js');

const _ = require('lodash');

const zlib = require('zlib');

const fs = require('fs');
const cc = require('../extension/cloudcache/cloudcache.js');

const Promise = require('bluebird');

Promise.promisifyAll(fs);

const inflateAsync = Promise.promisify(zlib.inflate);

const hashKey = "gsb:bloomfilter:compressed";

const legacyIntelCacheFile = `${f.getUserConfigFolder()}/intel_cache.file`;

class IntelLocalCachePlugin extends Sensor {

  async run() {
    this.working = true;
    try {
      // remove legacy cache file
      await fs.unlinkAsync(legacyIntelCacheFile).catch(() => undefined);
      await cc.enableCache(hashKey, (data) => {
        if (data) {
          this.loadBFData(data);
          this.working = true;
        } else {
          log.error("No valid bf data. Delete url bf cache data.");
          this.deleteBFData();
          this.working = false;
        }
      });
    } catch(err) {
      log.error("Failed to process url bf data");        
    }
  }

  isWorking() {
    return this.working;
  }

  async loadBFData(content) {
    try {
      if(!content || content.length < 10) {
        // likely invalid, return null for protection
        log.error(`Invalid bf data content for ${prefix}, ignored`);
        return;
      }

      const buf = Buffer.from(content, 'base64');
      const data = await inflateAsync(buf);
      const dataString = data.toString();
      const payload = JSON.parse(dataString);
      const bf = new BloomFilter(payload, 16);
      this.bf = bf;
      log.info(`Loaded url intel hash successfully.`);
    } catch(err) {
      log.error("Failed to update bf data, err:", err);
    }
  }

  deleteBFData() {
    this.bf = null;
  }

  checkUrl(url) {
    // for testing only
    if (this.config && this.config.testURLs && this.config.testURLs.includes(url)) {
      return true;
    }

    if (!this.bf) {
      return false;
    }

    const hashes = urlhash.canonicalizeAndHashExpressions(url);

    const matchedHashes = hashes.filter((hash) => {
      if (!hash) {
        return false;
      }

      const prefix = hash[1];

      if (!prefix) {
        return false;
      }

      const prefixHex = this.toHex(prefix);

      const testResult = this.bf.test(prefixHex);
      return testResult;
    });

    return !_.isEmpty(matchedHashes);
  }

  toHex(base64) {
    return Buffer.from(base64, 'base64').toString('hex');
  }
}

module.exports = IntelLocalCachePlugin;
