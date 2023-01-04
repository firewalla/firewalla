/*    Copyright 2021 Firewalla INC
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

const Buffer = require('buffer').Buffer;

const featureName = "fast_intel";

const exec = require('child-process-promise').exec;

const Promise = require('bluebird');
const jsonfile = require('jsonfile');
const jsonWriteFileAsync = Promise.promisify(jsonfile.writeFile);

const bf = require('../extension/bf/bf.js');

class FastIntelPlugin extends Sensor {
  async run() {
    this.hookFeature(featureName);
    this.bfMap = {};
    this.working = true;
  }

  isWorking() {
    return this.working;
  }

  async globalOn() {
    log.info("Turning on fast intel...");
    
    const data = this.config.data || [];
    if(_.isEmpty(data)) {
      log.warn("Invalid fast intel data, it's empty");
      return;
    }

    // generate intel proxy config
    await this.generateIntelProxyConfig();

    // download bf files
    for(const item of data) {
      const hashKeyName = bf.getHashKeyName(item);
      if(!hashKeyName) continue;

      try {
        await cc.enableCache(hashKeyName, async (content) => {
          const filepath = this.getFile(item);
          if (content) {
            await bf.updateBFData(item, content, filepath);
            this.working = true;
          } else {
            log.error("no fast intel data. delete data file");
            await bf.deleteBFData(filepath);
            this.working = false;
          }
          // always restart intel proxy when bf data is updated
          await this.restartIntelProxy();
        });
      } catch(err) {
        log.error("Failed to process bf data:", item);        
      }

      await this.restartIntelProxy();
    }

    log.info("Fast intel is turned on successfully.");
  }

  async restartIntelProxy() {
    log.info("Restarting intel proxy...");
    await exec("sudo systemctl restart intelproxy").catch((err) => {
      log.error("Failed to restart intelproxy, err:", err);
    });
  }

  async generateIntelProxyConfig() {
    log.info("generating intel proxy config file...");
    const path = `${f.getRuntimeInfoFolder()}/intelproxy/config.json`;

    const bfs = [];

    const data = this.config.data || [];

    for(const item of data) {
      const size = item.count;
      const error = item.error;
      const file = this.getFile(item);
      bfs.push({size, error, file});
    }

    await jsonWriteFileAsync(path, {bfs}).catch((err) => {
      log.error("Failed to write intel proxy config file, err:", err);
    });
  }

  getFile(item) {
    return `${f.getRuntimeInfoFolder()}/intelproxy/${item.prefix}.bf.data`;
  }
  
  getIntelProxyBaseUrl() {
    return this.config.baseURL ? `http://${this.config.baseURL}` : "http://127.0.0.1:9964";

  }

  async globalOff() {
    log.info("Turning off fast intel...");
    const data = this.config.data || [];
    if(_.isEmpty(data)) {
      log.warn("Invalid fast intel data, it's empty");
      return;
    }

    for(const item of data) {
      if(!item.prefix) {
        continue;
      }
      
      const hashKeyName = bf.getHashKeyName(item);
      if(!hashKeyName) continue;
      
      await cc.disableCache(hashKeyName);
    }

    await exec("sudo systemctl stop intelproxy").catch((err) => {
      log.error("Failed to stop intelproxy, err:", err);
    });

    log.info("Fast intel is turned off...");
  }
}

module.exports = FastIntelPlugin;
