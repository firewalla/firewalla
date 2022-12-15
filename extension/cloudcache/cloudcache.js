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
const sclient = require('../../util/redis_manager.js').getSubscriptionClient();
const config = require('../../net2/config.js').getConfig();
const crypto = require('crypto');

const expirationDays = (config.cloudcache && config.cloudcache.expirationDays) || 30;
const _ = require('lodash');

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
    try {
      const content = await fs.readFileAsync(this.localCachePath, 'utf8');
      return content;
    } catch (e) {
      return null;
    }
  }

  async getLocalMetadata() {
    try {
      const data = await jsonReadFileAsync(this.localMetadataPath);
      return data;
    } catch (err) {
      log.debug("Failed to load local matadata:", this.localMetadataPath);
      return null;
    }
  }

  async checkLocalCacheIntegrity(expectedSha256) {
    const content = await fs.readFileAsync(this.localCachePath).catch(err => null);
    if (!content)
      return false;
    try {
      const actualSha256 = crypto.createHash('sha256').update(content).digest('hex');
      return actualSha256 == expectedSha256;
    } catch (err) {
      log.error(`Failed to calculate local content hash for ${this.name}`, err.message);
      return false;
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
    } catch (err) {
      log.error("Failed to load cloud metadata, err:", err);
      return null;
    }
  }

  async getCloudData() {
    return bone.hashsetAsync(this.cloudHashKey);
  }

  isExpired(currentTime, lastUpdateTime) {
    if (!currentTime || !lastUpdateTime) {
      return false;
    }
    const ageInDays = (currentTime - lastUpdateTime) / 86400;
    if (ageInDays > expirationDays) {
      return true;
    }
    return false;
  }

  async cleanUp() {
    try {
      await fs.unlinkAsync(this.localCachePath);
      await fs.unlinkAsync(this.localMetadataPath);
    } catch (e) {
      //
    }
  }

  async download(alwaysOnUpdate = false) {
    // return true if cache is supported on this key
    // return false if cache is not supported on this key

    let localMetadata = await this.getLocalMetadata();
    const cloudMetadata = await this.getCloudMetadata();

    // return false if cloud cache is not supported for this key.
    if (!localMetadata && (!cloudMetadata || _.isEmpty(cloudMetadata))) {
      if (this.onUpdateCallback) {
        this.onUpdateCallback(null);
      }
      return false;
    }

    const currentTime = new Date().getTime() / 1000;
    let needDownload = true;

    let localIntegrity = false;
    if (localMetadata && localMetadata.sha256sum) {
      localIntegrity = await this.checkLocalCacheIntegrity(localMetadata.sha256sum);
    }

    // cloud metadata doesn't exist.
    if (localMetadata && _.isEmpty(cloudMetadata) || !cloudMetadata.updated || !cloudMetadata.sha256sum) {
      log.info(`Invalid file ${this.name} from cloud, ignored`);
      needDownload = false;
    }

    // protect from server time screw
    if (cloudMetadata && currentTime < cloudMetadata.updated) {
      cloudMetadata.updated = currentTime;
    }

    // cloud metadata has same checksum as local one. update timestamp
    if (localMetadata && cloudMetadata &&
      localMetadata.sha256sum && cloudMetadata.sha256sum &&
      localMetadata.sha256sum === cloudMetadata.sha256sum) {
      if (localMetadata.updated < cloudMetadata.updated) {
        await this.writeLocalMetadata(cloudMetadata);
      }
      if (localIntegrity) {
        log.info(`skip updating, cache ${this.name} is already up to date`);
        needDownload = false;
      } else {
        log.warn(`local cache content sha256 of ${this.name} mismatches with that in local metadata, need to download from cloud`);
      }
    }

    // cloud metadata has different checksum but with older timestamp than current one. Just ignore remote one. This is unlikely to occur.
    if (localMetadata && cloudMetadata && localIntegrity && localMetadata.sha256sum && cloudMetadata.sha256sum && localMetadata.sha256sum !== cloudMetadata.sha256sum && cloudMetadata.updated < localMetadata.updated) {
      log.info(`cloud metadata for ${this.name} is older than local one. skip updating`);
      needDownload = false;
    }

    let localContent = null;
    let hasNewData = false;

    // download cloud data if needed.
    if (needDownload && !this.isExpired(currentTime, cloudMetadata.updated)) {
      log.info(`Downloading ${this.cloudHashKey}...`);
      const cloudContent = await this.getCloudData();
      log.info(`Download Complete for ${this.cloudHashKey}!`);
      await this.writeLocalCacheContent(cloudContent);
      await this.writeLocalMetadata(cloudMetadata);
      localContent = cloudContent;
      localMetadata = cloudMetadata;

      let updatedTime = "unknown";
      if (cloudMetadata.updated) {
        updatedTime = new Date(cloudMetadata.updated * 1000);
      }
      hasNewData = true;
      log.info(`Updating cache file ${this.name}, updated at ${updatedTime}`);
    }

    // check local data and update
    if (!localContent) {
      localContent = await this.getLocalCacheContent();
    }

    if (localMetadata && this.isExpired(currentTime, localMetadata.updated)) {
      log.error(`Cloud cache item ${this.cloudHashKey} is obsolete. Delete cache data`);
      await this.cleanUp();
      if (this.onUpdateCallback) {
        this.onUpdateCallback(null);
      }
    } else {
      if ((alwaysOnUpdate || hasNewData) && this.onUpdateCallback) {
        this.onUpdateCallback(localContent);
      }
    }

    return true;
  }

  onUpdate(callback) {
    this.onUpdateCallback = callback;
  }
}

class CloudCache {
  constructor() {
    log.info(`Cloud cache expiration is set to ${expirationDays} day(s)`);
    if (instance === null) {
      instance = this;
      this.items = {};

      setInterval(() => {
        this.job();
      }, 1800 * 1000); // every half hour

      const eventType = "CLOUDCACHE_FORCE_REFRESH";
      sclient.subscribe(eventType);
      sclient.on("message", (channel, message) => {
        if (channel === eventType) {
          this.job();
        }
      });
    }

    return instance;
  }

  async enableCache(name, onUpdateCallback) {
    this.items[name] = new CloudCacheItem(name);
    if (onUpdateCallback) {
      this.items[name].onUpdate(onUpdateCallback);
    }
    try {
      // always call onUpdateCallback for the first time
      return (await this.items[name].download(true));
    } catch (err) {
      log.error("Failed to download cache data for", name, "err:", err);
      return null;
    }
  }

  async disableCache(name) {
    delete this.items[name];
    // do not remove the local cache file just in case it will be enabled again in the near future
  }

  async job() {
    for (const name in this.items) {
      const item = this.items[name];
      try {
        await item.download();
      } catch (err) {
        log.error("Failed to processs cache", name, "err:", err);
      }
    }
  }

  async forceLoad(name) {
    const item = this.items[name];
    if (!item) {
      return;
    }

    return item.download();
  }

  async getCache(name) {
    const item = this.items[name];
    if (!item) {
      return;
    }

    return item.getCloudData().catch((err) => {
      log.error("Failed to load cloud data for", name, "err:", err);
      return null;
    });
  }

  getCacheItem(name) {
    return this.items[name];
  }
}

module.exports = new CloudCache();