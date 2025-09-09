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
const bone = require('../lib/Bone.js');
const util = require('util');
const readFileAsync = util.promisify(fs.readFile);
const CategoryUpdater = require('../control/CategoryUpdater.js');
const categoryUpdater = new CategoryUpdater();

const { first } = require('underscore');
const targetListKey = "allcat_bf";

class FastIntelPlugin extends Sensor {
  constructor(config) {
    super(config);
    this.bfInfoMap = new Map();
    this.working = false;
    this.targetListKey = config.targetListKey || targetListKey;
  }

  async run() {
    this.hookFeature(featureName);
    this.bfMap = {};
    this.working = true;
    setInterval(this.refresh_bf.bind(this), this.config.regularInterval * 1000);
  }

  isWorking() {
    return this.working;
  }

  async getTargetList() {
    const infoHashsetId = `info:app.${this.targetListKey}`;
    try {
      const result = await bone.hashsetAsync(infoHashsetId);
      let targetListInfo = JSON.parse(result);
      let targetList;
      if (_.isObject(targetListInfo)) {
        if (targetListInfo["parts"] && _.isArray(targetListInfo["parts"])) {
          targetList = targetListInfo.parts;
        } else if (targetListInfo["id"] && _.isString(targetListInfo["id"])) {
          targetList = [targetListInfo.id];
        }
      }
      return targetList || null;
    } catch (e) {
      log.error("Fail to fetch target list info, key:", infoHashsetId, ",error:", e);
      return null;
    }
  }

  async removeData(part) {
    const bfDataFile = this.getFile(part);

    await fs.unlinkAsync(bfDataFile).catch(() => undefined); // ignore error
  }

  // return true on successful update.
  // return false on skip.
  // raise error on failure.
  async updateData(part, content) {
    log.debug("Update fast_intel bloom filter data for parts:", part);
    const obj = JSON.parse(content);
    if (!obj.data || !obj.info) {
      throw new Error("Invalid bloom filter data, missing data or info field");
    }

    let bfInfo = {key: part, size: obj.info.s, error: obj.info.e};
    this.bfInfoMap.set(part, bfInfo);

    const bfDataFile = this.getFile(part);

    let currentFileContent;
    try {
      currentFileContent = await readFileAsync(bfDataFile);
    } catch (e) {
      currentFileContent = null;
    }

    const buf = Buffer.from(obj.data, "base64");
    if (currentFileContent && buf.equals(currentFileContent)) {
      log.debug(`No filter update for fast_intel part:${part}, skip`);
      return false;
    }

    try {
      const need_decompress = false;
      await bf.updateBFData({perfix:part}, obj.data, bfDataFile, need_decompress);
    } catch(e){
      log.error("Failed to process data file, err:", e);
      throw new Error(`Failed to updateBFData for ${part}, err: ${e.message}`);
    };

    return true;
  }


  async refresh_bf(firstRun = false) {
    if (!this.working && !firstRun) {
      log.warn("Fast intel is not working, skip refreshing bloom filter");
      return;
    }

    let isConfigChanged = false;

    log.info("Refreshing bloom filter...");
    const newParts = await this.getTargetList();

    if (!newParts || newParts.length === 0) {
      log.error("No target list found, skip applying fast_intel policy");
      return;
    }

    const prevParts = categoryUpdater.getCategoryBfParts(this.targetListKey) || [];
    // if prevParts is empty or not equal to newParts, we need to set isConfigChanged to true
    if (prevParts.length === 0 || !_.isEqual(prevParts, newParts)) {
      isConfigChanged = true;
    }
    const removedParts = _.difference(prevParts, newParts);

    log.info(`Current parts of fast_intel bf:`, newParts);
    log.info(`Previous parts of fast_intel bf:`, prevParts);
    log.info(`Removed parts of fast_intel bf:`, removedParts)
    await categoryUpdater.setCategoryBfParts(this.targetListKey, newParts)
    // remove old bloom filter data files
    for (const part of removedParts) {
      const hashsetName = `bf:app.${part}`;
      await cc.disableCache(hashsetName);
      this.removeData(part);
      this.bfInfoMap.delete(part);
    }
    
    for (const part of newParts) {
      const hashsetName = `bf:app.${part}`;
      let currentCacheItem = cc.getCacheItem(hashsetName);
      if (currentCacheItem) {
        await currentCacheItem.download();
      } else {
        log.debug("Add fast_intel bf data item to cloud cache:", part);
        await cc.enableCache(hashsetName);
        currentCacheItem = cc.getCacheItem(hashsetName);
      }
      try {
        const content = await currentCacheItem.getLocalCacheContent();
        if (content) {
          const isUpdated = await this.updateData(part, content);
          if  (isUpdated) {
            isConfigChanged = true;
          }
        } else {
          // remove obselete category data
          log.error(`fast_intel part ${part} data is invalid. Remove it`);
          await this.removeData(part);
          this.bfInfoMap.delete(part);
        }
      } catch (e) {
        log.error(`Fail to update filter data for fast_intel part: ${part}.`, e);
        return;
      }
    }

    if (firstRun || isConfigChanged) {
      // generate intel proxy config
      await this.generateIntelProxyConfig();
      // restart intel proxy
      await this.restartIntelProxy();
    }

  }

  async globalOn() {
    log.info("Turning on fast intel...");

    // remove obsolete bloom filter data
    const data = this.config.data || [];
    if (data.length > 0) {
      for (const item of data) {
        this.removeData(item.prefix);
      }
    }

    await this.refresh_bf(true);
    this.working = true;

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

    for (const [key, value] of this.bfInfoMap) {
      const size = value.size;
      const error = value.error;
      const file = this.getFile(key);
      bfs.push({size, error, file});
    }

    await jsonWriteFileAsync(path, {bfs}).catch((err) => {
      log.error("Failed to write intel proxy config file, err:", err);
    });
  }

  getFile(item) {
    return `${f.getRuntimeInfoFolder()}/intelproxy/${item}.bf.data`;
  }
  
  getIntelProxyBaseUrl() {
    return this.config.baseURL ? `http://${this.config.baseURL}` : "http://127.0.0.1:9964";

  }

  async globalOff() {
    log.info("Turning off fast intel...");

    for (const [key, _bfInfo] of this.bfInfoMap) {
      const hashsetName = `bf:app.${key}`;
      await cc.disableCache(hashsetName).catch((err) => {
        log.error("Failed to disable cache for", key, "err:", err);
      });
    }

    await exec("sudo systemctl stop intelproxy").catch((err) => {
      log.error("Failed to stop intelproxy, err:", err);
    });

    log.info("Fast intel is turned off...");
  }
}

module.exports = FastIntelPlugin;
