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

const updateInterval = 2 * 24 * 3600 * 1000 // once per two days

const hashKey = "gsb:bloomfilter:compressed";

const BloomFilter = require('../vendor_lib/bloomfilter.js').BloomFilter;

const urlhash = require("../util/UrlHash.js");

const _ = require('lodash');

const bone = require("../lib/Bone.js");

const zlib = require('zlib');

const Promise = require('bluebird');

const inflateAsync = Promise.promisify(zlib.inflate);

class IntelLocalCachePlugin extends Sensor {

  async loadCacheFromBone() {
    log.info(`Loading intel cache from cloud...`);
    try {
      const data = await bone.hashsetAsync(hashKey)
      const buffer = Buffer.from(data, 'base64');
      const decompressedData = await inflateAsync(buffer);
      const decompressedString = decompressedData.toString();
      const payload = JSON.parse(decompressedString);
      // jsonfile.writeFileSync("/tmp/x.json", payload);
      this.bf = new BloomFilter(payload, 16);
      log.info(`Intel cache is loaded successfully! cache size ${decompressedString.length}`);
    } catch (err) {
      log.error(`Failed to load intel cache from cloud, err: ${err}`);
      this.bf = null;
    }
  }

  async run() {
    await this.loadCacheFromBone();

    setInterval(() => {
      this.loadCacheFromBone();
    }, updateInterval);
  }

  checkUrl(url) {
    // for testing only
    if(this.config && this.config.testURLs && this.config.testURLs.includes(url)) {
      return true;
    }

    if(!this.bf) {
      return false;
    }

    const hashes = urlhash.canonicalizeAndHashExpressions(url);

    const matchedHashes = hashes.filter((hash) => {
      if(!hash) {
        return false;
      }

      const prefix = hash[1];

      if(!prefix) {
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
