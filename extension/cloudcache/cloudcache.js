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

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const jsonfile = require('jsonfile');
const jsonReadFileAsync = Promise.promisify(jsonfile.readFile);
const jsonWriteFileAsync = Promise.promisify(jsonfile.writeFile);

const f = require('../../net2/Firewalla.js');
const cacheFolder = `${f.getRuntimeInfoFolder()}/cache`;
const log = require('../../net2/logger.js')(__filename);
const bone = require("../../lib/Bone.js");

let instance = null;

class CloudCacheItem {
  constructor(name) {
    this.localCachePath = `${cacheFolder}/${name}`;
    this.localMetadataPath = `${this.localCachePath}.metadata`;
    this.cloudHashKey = name;
    this.cloudMetadataHashKey = `metadata:${name}`;
    this.name = name;
  }

  async getLocalCacheContent() {
    return fs.readFileAsync(this.localCachePath, 'utf8');
  }

  async getLocalMetadata() {
    try {
      const data = await jsonReadFileAsync(this.localMetadataPath);
      return data;
    } catch (err) {
      log.error("Failed to load local matadata:", this.localMetadataPath, "err:", err);
      return null;
    }
  }

  async writeLocalCacheContent(data) {
    return fs.writeFileAsync(this.localCachePath, data);
  }

  async writeLocalMetadata(metadata) {
    return jsonWriteFileAsync(this.localMetadataPath, metadata);
  }

  async getCloudMetadata() {
    try {
      const jsonString = await bone.hashsetAsync(this.cloudMetadataHashKey);
      return JSON.parse(jsonString);
    } catch(err) {
      log.error("Failed to load cloud metadata, err:", err);
      return;
    }
  }

  async getCloudData() {
    return bone.hashsetAsync(this.cloudHashKey);
  }

  async download(alwaysOnUpdate = false) {
    const localMetadata = await this.getLocalMetadata();
    const cloudMetadata = await this.getCloudMetadata();
    if(localMetadata && cloudMetadata &&
       localMetadata.sha256sum && cloudMetadata.sha256sum &&
       localMetadata.sha256sum === cloudMetadata.sha256sum) {
      if(alwaysOnUpdate && this.onUpdateCallback) {
        const localContent = await this.getLocalCacheContent();
        this.onUpdateCallback(localContent);
      }
      log.info(`skip updating, cache ${this.name} is already up to date`);
      return;
    }
    const cloudContent = await this.getCloudData();
    await this.writeLocalCacheContent(cloudContent);
    await this.writeLocalMetadata(cloudMetadata);
    if(this.onUpdateCallback) {
      this.onUpdateCallback(cloudContent);
    }
  }

  onUpdate(callback) {
    this.onUpdateCallback = callback;
  }
}

class CloudCache {
  constructor() {
    if(instance === null) {
      instance = this;
      this.items = {};

      setTimeout(() => {
        this.job();
      }, 1800 * 1000); // every half hour
    }

    return instance;
  }

  async enableCache(name, onUpdateCallback) {
    this.items[name] = new CloudCacheItem(name);
    if(onUpdateCallback) {
      this.items[name].onUpdate(onUpdateCallback);
    }
    try {
      // always call onUpdateCallback for the first time
      await this.items[name].download(true);
    } catch(err) {
      log.error("Failed to download cache data for", name, "err:", err);
    }
  }

  async disableCache(name) {
    delete this.items[name];
    // do not remove the local cache file just in case it will be enabled again in the near future
  }

  async job() {
    for(const name in this.items) {
      const item = this.items[name];
      try {
        await item.download();
      } catch(err) {
        log.error("Failed to processs cache", name, "err:", err);
      }
    }
  }

  async forceLoad(name) {
    const item = this.items[name];
    if(!item) {
      return;
    }

    return item.download();
  }

  async getCache(name) {
    const item = this.items[name];
    if(!item) {
      return;
    }
    
    return item.getCloudData().catch((err) => {
      log.error("Failed to load cloud data for", name, "err:", err);
      return null;
    });
  }
}

module.exports = new CloudCache();