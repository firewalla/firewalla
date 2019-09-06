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

const f = require('../net2/Firewalla.js');

const _ = require('lodash');

const bone = require("../lib/Bone.js");

const zlib = require('zlib');

const fs = require('fs');

const Promise = require('bluebird');

Promise.promisifyAll(fs);

const inflateAsync = Promise.promisify(zlib.inflate);

const intelCacheFile = `${f.getUserConfigFolder()}/intel/intel_cache.file`;

class IntelLocalCachePlugin extends Sensor {

  async loadCacheFromBone() {
    log.info(`Loading intel cache from cloud...`);
    const data = await bone.hashsetAsync(hashKey);
    if(data) {
      const bf = await this.loadCacheFromBase64(data);
      if(bf) {
        this.bf = bf;
      }
    }

    if(!this.bf) {
      // fallback to load from local file system
      await this.loadCacheFromLocal(intelCacheFile);
    }
  }

  async loadCacheFromLocal(path) {
    try {
      await fs.accessAsync(path, fs.constants.R_OK);
log.info(`Loading data from path: ${path}`);
      const data = await fs.readFileAsync(path,{encoding: 'utf8'});
      if(data) {
        const bf = await this.loadCacheFromBase64(data);
        if(bf) {
          this.bf = bf;
        }
      }
    } catch(err) {
      log.info("Local intel file not exist, skipping...");
      return;
    }
  }

  async loadCacheFromBase64(data) {
    try {
      const data = await bone.hashsetAsync(hashKey)
      const buffer = Buffer.from(data, 'base64');
      const decompressedData = await inflateAsync(buffer);
      const decompressedString = decompressedData.toString();
      const payload = JSON.parse(decompressedString);
      const bf = new BloomFilter(payload, 16);
      log.info(`Intel cache is loaded successfully! cache size ${decompressedString.length}`);
      return bf;
    } catch(err) {
      log.error(`Failed to load cache data, err: ${err}`);
      return null;
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
