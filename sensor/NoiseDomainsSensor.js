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

const Sensor = require('./Sensor.js').Sensor;

const _ = require('lodash');
const rclient = require('../util/redis_manager.js').getRedisClient();
const Constants = require('../net2/Constants.js');
const { BloomFilter } = require('../vendor_lib/bloomfilter.js');
const CLOUD_CONFIG_KEY = Constants.REDIS_KEY_NOISE_DOMAIN_CLOUD_CONFIG;
const cc = require('../extension/cloudcache/cloudcache.js');
const fsp = require('fs').promises;
const f = require('../net2/Firewalla.js');
const cacheFolder = `${f.getRuntimeInfoFolder()}/cache`;
const hashKey = "noise_domain";

class NoiseDomainsSensor extends Sensor {
  async run() {
    return this.init();
  }

  async apiRun() {
    return this.init();
  }
  
  async init() {
    this.bloomfilter = null;
    await cc.enableCache(hashKey, (data) => {
      if (data) {
        this.loadNoiseDomainBFData(data);
      } else {
        log.error("No valid bf data. Delete url bf cache data.");
        this.deleteNoiseDomainBFData();
      }
    });
    await this.removeLegacyNoiseBFfromRedis();
  }

  async loadNoiseDomainBFData(content) {
    try {
      if (typeof content !== 'string' || !content.trim()) return;
      const { buckets, k } = JSON.parse(content);
      if (buckets == null || k == null) return;
      this.bloomfilter = new BloomFilter(this._decodeArrayOfIntBase64(buckets), k);
      log.info('Loaded noise domain bloom filter successfully.');
    } catch (err) {
      log.error('Failed to load noise domain bloom filter, err:', err);
    }
  }

  async loadLocalNoiseDomainData4Test() {
    this.bloomfilter = null;
    const noiseDomainDataFile = `${cacheFolder}/${hashKey}`;
    const content = await fsp.readFile(noiseDomainDataFile, 'utf8');
    if (content) {
      this.loadNoiseDomainBFData(content);
    } else {
      log.error(`No valid noise domain data found in ${noiseDomainDataFile}.`);
      return;
    }
  }

  deleteNoiseDomainBFData() {
    this.bloomfilter = null;
  }

  async removeLegacyNoiseBFfromRedis() {
    await rclient.delAsync(CLOUD_CONFIG_KEY);
  }

  _decodeArrayOfIntBase64(s) {
    const buf = Buffer.from(s, 'base64');
    const arr = [];
    for (let i = 0; i < buf.length; i += 4) {
      arr.push(buf.readInt32LE(i));
    }
    return arr;
  }

  find(domain, isIP = false) {
    if(!domain || !this.bloomfilter) {
      return new Set();
    }
    if (isIP) {
      return this.bloomfilter.test(domain) ? new Set(["noise"]) : new Set();
    }
    const reversedParts = domain.split('.').reverse();
    for (let i = reversedParts.length - 1; i >= 0; i--) {
      const subDomain = reversedParts.slice(0, i + 1).reverse().join('.');
      if(this.bloomfilter.test(subDomain)) {
        return new Set(["noise"]);
      }
    }
    return new Set();
  }
}

module.exports = NoiseDomainsSensor;
