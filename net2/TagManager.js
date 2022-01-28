/*    Copyright 2020-2022 Firewalla Inc.
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

const _ = require('lodash');
const log = require('./logger.js')(__filename);
const rclient = require('../util/redis_manager.js').getRedisClient();
const f = require('./Firewalla.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const sysManager = require('./SysManager.js');
const asyncNative = require('../util/asyncNative.js');
const Tag = require('./Tag.js');

class TagManager {
  constructor() {
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    this.tags = {};

    this.scheduleRefresh();

    if (f.isMain()) {
      sem.once('IPTABLES_READY', async () => {
        log.info("Iptable is ready, apply tag policies ...");
        this.scheduleRefresh();
      });
    }

    this.subscriber.subscribeOnce("DiscoveryEvent", "Tags:Updated", null, async (channel, type, id, obj) => {
      log.info(`Tags are updated`);
      this.scheduleRefresh();
    });

    return this;
  }

  scheduleRefresh() {
    if (this.refreshTask)
      clearTimeout(this.refreshTask);
    this.refreshTask = setTimeout(async () => {
      await this.refreshTags();
      if (f.isMain()) {
        if (sysManager.isIptablesReady()) {
          for (let uid in this.tags) {
            const tag = this.tags[uid];
            tag.scheduleApplyPolicy();
          }
        }
      }
    }, 1000);
  }

  async toJson() {
    const json = {};
    for (let uid in this.tags) {
      await this.tags[uid].loadPolicy();
      json[uid] = this.tags[uid].toJson();
    }
    return json;
  }

  async _getNextTagUid() {
    let uid = await rclient.getAsync("tag:uid");
    if (!uid) {
      uid = 1;
      await rclient.setAsync("tag:uid", uid);
    }
    await rclient.incrAsync("tag:uid");
    return uid;
  }

  // This function should only be invoked in FireAPI. Please follow this rule!
  async createTag(name, obj) {
    const newUid = await this._getNextTagUid();
    for (let uid in this.tags) {
      if (this.tags[uid].o && this.tags[uid].o.name === name) {
        if (obj) {
          const tag = Object.assign({}, obj, {uid: uid, name: name});
          const key = `tag:uid:${uid}`;
          await rclient.hmsetAsync(key, tag);
          this.subscriber.publish("DiscoveryEvent", "Tag:Updated", null, tag);
          await this.refreshTags();
        }
        return this.tags[uid].toJson();
      }
    }
    // do not directly create tag in this.tags, only update redis tag entries
    // this.tags will be created from refreshTags() together with createEnv()
    if (!obj)
      obj = {};
    const tag = Object.assign({}, obj, {uid: newUid, name: name});
    const key = `tag:uid:${newUid}`;
    await rclient.hmsetAsync(key, tag);
    this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, tag);
    await this.refreshTags();
    return this.tags[newUid].toJson();
  }

  // This function should only be invoked in FireAPI. Please follow this rule!
  async removeTag(name) {
    for (let uid in this.tags) {
      if (this.tags[uid].o && this.tags[uid].o.name === name) {
        const key = `tag:uid:${uid}`;
        await rclient.delAsync(key);
        this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, this.tags[uid].o);
        await this.refreshTags();

        return;
      }
    }
    log.warn(`Tag ${name} does not exist, no need to remove it`);
  }

  async changeTagName(uid, name) {
    if (_.has(this.tags, uid) && this.getTag(name) == null) {
      this.tags[uid].setTagName(name);
      const key = `tag:uid:${uid}`;
      await rclient.hmsetAsync(key, this.tags[uid].o);
      this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, this.tags[uid].o);
      return true;
    }

    return false;
  }

  getTag(name) {
    for (let uid in this.tags) {
      if (this.tags[uid].getTagName() === name)
        return this.tags[uid];
    }
    return null;
  }

  getTagByUid(uid) {
    return uid && this.tags[uid];
  }

  async refreshTags() {
    const markMap = {};
    for (let uid in this.tags) {
      markMap[uid] = false;
    }

    const keys = await rclient.scanResults("tag:uid:*");
    for (let key of keys) {
      const o = await rclient.hgetallAsync(key);
      const uid = key.substring(8);
      if (this.tags[uid]) {
        await this.tags[uid].update(o);
      } else {
        this.tags[uid] = new Tag(o);
        if (f.isMain()) {
          if (sysManager.isIptablesReady()) {
            log.info(`Creating environment for tag ${uid} ${o.name} ...`);
            await this.tags[uid].createEnv();
          } else {
            sem.once('IPTABLES_READY', async () => {
              log.info(`Creating environment for tag ${uid} ${o.name} ...`);
              await this.tags[uid].createEnv();
            });
          }
        }
      }
      markMap[uid] = true;
    }

    const removedTags = {};
    Object.keys(this.tags).filter(uid => markMap[uid] === false).map((uid) => {
      removedTags[uid] = this.tags[uid];
    });
    for (let uid in removedTags) {
      if (f.isMain()) {
        if (sysManager.isIptablesReady()) {
          log.info(`Destroying environment for tag ${uid} ${removedTags[uid].name} ...`);
          await removedTags[uid].destroyEnv();
        } else {
          sem.once('IPTABLES_READY', async () => {
            log.info(`Destroying environment for tag ${uid} ${removedTags[uid].name} ...`);
            await removedTags[uid].destroyEnv();
          });
        }
      }
      delete this.tags[uid];
    }
    return this.tags;
  }

  async loadPolicyRules() {
    await asyncNative.eachLimit(Object.values(this.tags), 10, id => id.loadPolicy())
  }
}

const instance = new TagManager();
module.exports = instance;
