/*    Copyright 2021 Firewalla LLC
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

const _ = require('lodash');

const fc = require('../net2/config.js');

const f = require('../net2/Firewalla.js');

const BloomFilter = require('../vendor_lib/bloomfilter.js').BloomFilter;

const cc = require('../extension/cloudcache/cloudcache.js');

const zlib = require('zlib');
const fs = require('fs');

const Promise = require('bluebird');
const inflateAsync = Promise.promisify(zlib.inflate);
Promise.promisifyAll(fs);

const Buffer = require('buffer').Buffer;

const featureName = "fast_intel";

class FastIntelPlugin extends Sensor {
  async run() {
    this.hookFeature(featureName);
    this.bfMap = {};
  }

  getHashKeyName(item = {}) {
    if(!item.bits || !item.hashes || !item.prefix) {
      log.error("Invalid item:", item);
      return null;
    }

    const {bits, hashes, prefix} = item;
    
    return `bf:${prefix}:${bits}:${hashes}`;
  }

  async globalOn() {
    const data = this.config.data || [];
    if(_.isEmpty(data)) {
      return;
    }

    for(const item of data) {
      const hashKeyName = this.getHashKeyName(item);
      if(!hashKeyName) continue;

      try {
        await cc.enableCache(hashKeyName, (data) => {
          this.loadBFData(item, data);
        });
      } catch(err) {
        log.error("Failed to process bf data:", item);        
      }
    }    
  }

  testIndicator(indicator) {
    if(!fc.isFeatureOn(featureName)) {
      return false;
    }
    
    for(const i in this.bfMap) {
      const bf = this.bfMap[i];
      if(bf.test(indicator)) {
        return true;
      }
    }

    return false;
  }

  // load bf data into memory
  async loadBFData(item, content) {
    try {
      const {prefix, hashes} = item;

      if(!content || content.length < 10) {
        // likely invalid, return null for protection
        log.error(`Invalid bf data content for ${prefix}, ignored`);
        return;
      }

      const buf = Buffer.from(content, 'base64');
      const data = await inflateAsync(buf);
      const dataString = data.toString();
      const payload = JSON.parse(dataString);
      const bf = new BloomFilter(payload, item.hashes);
      this.bfMap[prefix] = bf;
      log.info(`Loaded BF Data ${item.prefix} successfully.`);
    } catch(err) {
      log.error("Failed to update bf data, err:", err);
    }
  }

  async globalOff() {
    const data = this.config.data || [];
    if(_.isEmpty(data)) {
      return;
    }

    for(const item of data) {
      if(!item.prefix) {
        continue;
      }
      
      const hashKeyName = this.getHashKeyName(item);
      if(!hashKeyName) continue;
      
      await cc.disableCache(hashKeyName);
      delete this.bfMap[item.prefix];
    }
  }
}

module.exports = FastIntelPlugin;
