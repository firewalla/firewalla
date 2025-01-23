/*    Copyright 2020-2025 Firewalla Inc.
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
const sysManager = require('./SysManager.js');
const asyncNative = require('../util/asyncNative.js');
const Tag = require('./Tag.js');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const Constants = require('./Constants.js');
const dnsmasq = new DNSMASQ();
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock()
const KEY_TAG_INDEXED = 'tag:indexed'

class TagManager {
  constructor() {
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    this.tags = {};

    this.scheduleRefresh();

    this.subscriber.subscribeOnce("DiscoveryEvent", "Tags:Updated", null, async (channel, type, id, obj) => {
      this.scheduleRefresh();
    });

    if (f.isMain()) {
      this.buildIndex();
      // periodically sync group macs to fwapc in case of inconsistency
      setInterval(async () => {
        if (sysManager.isIptablesReady()) {
          for (const uid of Object.keys(this.tags)) {
            const tag = this.tags[uid];
            if (await this.tagUidExists(uid)) {
              await Tag.scheduleFwapcSetGroupMACs(uid, tag.getTagType()).catch((err) => {
                log.error(`Failed to sync macs to tag ${uid}`);
              });
            }
          }
        }
      }, 900 * 1000);
    }

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
    await this.loadPolicyRules()
    for (let uid in this.tags) {
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
    return String(uid);
  }

  async createTag(name, obj, affiliatedName, affiliatedObj) {
    if (!obj)
      obj = {};
    const type = obj.type || Constants.TAG_TYPE_GROUP;
    if (!Constants.TAG_TYPE_MAP[type]) {
      log.error('Unsupported tag type:', type)
      return null
    }

    return lock.acquire(`createTag_${name}_${type}`, async() => {
      let afTag = null;
      // create a native affiliated device group for this tag, usually affiliated to a user group
      if (affiliatedName && affiliatedObj) {
        afTag = await this.createTag(affiliatedName, affiliatedObj);
        if (afTag) {
          obj.affiliatedTag = afTag.getUniqueId();
        }
      }

      const existingTag = this.getTagByName(name, type)
      if (existingTag) {
        if (obj) {
          existingTag.o = Object.assign({}, obj, {uid: existingTag.getUniqueId(), name});
          existingTag.save()
          this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, existingTag.o);
        }
        if (afTag)
          await afTag.setPolicyAsync(Constants.TAG_TYPE_MAP[type].policyKey, [ existingTag.getUniqueId() ]);
        return existingTag
      }

      const newUid = await this._getNextTagUid();
      const now = Math.floor(Date.now() / 1000);
      const newTag = new Tag(Object.assign({}, obj, {uid: newUid, name: name, createTs: now}))
      await newTag.save()
      await rclient.saddAsync(Constants.TAG_TYPE_MAP[type].redisIndexKey, newUid)
      this.tags[newUid] = newTag

      this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, newTag);
      if (afTag) {
        await afTag.setPolicyAsync(Constants.TAG_TYPE_MAP[type].policyKey, [ String(newUid) ]);
        newTag.afTag = afTag
      }

      return newTag
    })
  }

  // This function should only be invoked in FireAPI. Please follow this rule!
  async removeTag(uid, name, type = Constants.TAG_TYPE_GROUP) { // remove tag by name is for backward compatibility
    uid = String(uid);

    if (_.has(this.tags, uid)) {
      const tagMap = Constants.TAG_TYPE_MAP[this.tags[uid].getTagType()]
      if (!tagMap) return
      const key = `${tagMap.redisKeyPrefix}${uid}`;
      await rclient.sremAsync(tagMap.redisIndexKey, uid)
      await rclient.unlinkAsync(key);
      this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, this.tags[uid].o);
      await this.refreshTags();
      return;
    }
    if (name && type) {
      const tagMap = Constants.TAG_TYPE_MAP[type]
      if (!tagMap) return
      for (let uid in this.tags) {
        if (this.tags[uid].o && this.tags[uid].o.name === name) {
          const key = `${tagMap.redisKeyPrefix}${uid}`;
          await rclient.sremAsync(tagMap.redisIndexKey, uid)
          await rclient.unlinkAsync(key);
          this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, this.tags[uid].o);
          await this.refreshTags();
          return;
        }
      }
    }
    log.warn(`Tag ${uid} does not exist, no need to remove it`);
  }

  async updateTag(uid, name, obj = {}) {
    uid = String(uid);
    if (_.has(this.tags, uid)) {
      const tag = this.tags[uid];
      const type = obj.type || tag.o.type || Constants.TAG_TYPE_GROUP; // keep original type if not defined in obj
      let changed = false;
      if (tag.getTagName() !== name) {
        tag.setTagName(name);
        changed = true;
      }
      // different type of tags are saved in different redis hash keys
      if (tag.o.type !== type) {
        const oldType = tag.o.type || Constants.TAG_TYPE_GROUP;
        const oldTagMap = _.get(Constants.TAG_TYPE_MAP, oldType);
        if (oldTagMap) {
          const oldKey = `${oldTagMap.redisKeyPrefix}${uid}`;
          await rclient.sremAsync(oldTagMap.redisIndexKey, uid)
          await rclient.unlinkAsync(oldKey);
        }
        changed = true;
      }
      if (type) {
        const tagMap = _.get(Constants.TAG_TYPE_MAP, type);
        if (tagMap) {
          const o = Object.assign({}, { uid, name }, tag.o, obj);
          const key = `${tagMap.redisKeyPrefix}${uid}`;
          await rclient.hmsetAsync(key, o);
          await rclient.saddAsync(tagMap.redisIndexKey, uid)
          changed = true;
        } else return null;
      }
      if (changed) {
        this.subscriber.publish("DiscoveryEvent", "Tags:Updated", null, tag);
        await this.refreshTags();
      }
      return this.tags[uid].toJson();
    }
    return null;
  }

  getTagByUid(uid) {
    return uid && this.tags[uid];
  }

  getTagByName(name, type = Constants.TAG_TYPE_GROUP) {
    if (!name)
      return null;
    for (const tag of Object.values(this.tags)) {
      if (tag.getTagType() == type && tag.o.name === name)
        return tag;
    }
    return null;
  }

  getTag(tagName) {
    const tag = this.getTagByUid(tagName);
    if (tag) {
      return tag;
    }
    return this.getTagByName(tagName);
  }

  async getPolicyTags(policyName) {
    let policyTags = [];
    for (const uid in this.tags) {
      if (await this.tags[uid].hasPolicyAsync(policyName)){
        policyTags.push(this.tags[uid]);
      }
    }
    return policyTags;
  }

  async tagUidExists(uid, type) {
    if (this.getTagByUid(uid))
      return true;
    for (const key of Object.keys(Constants.TAG_TYPE_MAP)) {
      if (!type || type === key) {
        const redisKeyPrefix = _.get(Constants.TAG_TYPE_MAP, [key, "redisKeyPrefix"]);
        if (redisKeyPrefix) {
          const result = await rclient.typeAsync(`${redisKeyPrefix}${uid}`);
          if (result !== "none")
            return true;
        }
      }
    }
    return false;
  }

  // this should be run only 1 time
  async buildIndex() {
    try {
      const indexed = await rclient.getAsync(KEY_TAG_INDEXED)
      if (Number(indexed)) return

      log.info('Building tag indexes ...')
      for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
        const config = Constants.TAG_TYPE_MAP[type];
        const keyPrefix = config.redisKeyPrefix;
        const keys = await rclient.scanResults(`${keyPrefix}*`);
        if (keys.length) {
          await rclient.saddAsync(config.redisIndexKey, keys.map(k => k.substring(keyPrefix.length)))
        }
      }

      await rclient.setAsync(KEY_TAG_INDEXED, 1)

      log.info('Tag indexes built')
    } catch(err) {
      log.error('Error building Tag indexes', err)
      await rclient.setAsync(KEY_TAG_INDEXED, 0)
    }
  }

  async refreshTags() {
    log.verbose('refreshTags')
    const markMap = {};
    for (let uid in this.tags) {
      markMap[uid] = false;
    }

    await Promise.all(Object.keys(Constants.TAG_TYPE_MAP).map(async type => {
      const config = Constants.TAG_TYPE_MAP[type];
      const IDs = await rclient.smembersAsync(config.redisIndexKey);
      const nameMap = {}
      await asyncNative.eachLimit(IDs, 30, async uid => {
        const key = config.redisKeyPrefix + uid
        const o = await rclient.hgetallAsync(key);
        if (!o) {
          await rclient.sremAsync(config.redisIndexKey, uid);
          return
        }
        // remove duplicate deviceTag
        if (o.type == Constants.TAG_TYPE_DEVICE) {
          if (nameMap[o.name]) {
            if (f.isMain()) {
              log.info('Remove duplicated deviceTag', uid)
              await rclient.sremAsync(config.redisIndexKey, uid);
              await rclient.unlinkAsync(key);
              this.subscriber.publish("DiscoveryEvent", "Tags:Updated");
            }
            return
          } else {
            nameMap[o.name] = true
          }
        }
        if (this.tags[uid]) {
          await this.tags[uid].update(Tag.parse(o));
        } else {
          this.tags[uid] = new Tag(Tag.parse(o));
        }
        markMap[uid] = true;
      })
    }))

    const removedTags = {};
    Object.keys(this.tags).filter(uid => markMap[uid] === false).map((uid) => {
      removedTags[uid] = this.tags[uid];
    });
    for (const uid in removedTags) {
      if (f.isMain()) {
        (async () => {
          await sysManager.waitTillIptablesReady()
          log.info(`Destroying environment for tag ${uid} ${removedTags[uid].name} ...`);
          await removedTags[uid].destroyEnv();
          await removedTags[uid].destroy();
          await dnsmasq.writeAllocationOption(uid, {})
        })()
      }
      delete this.tags[uid];
    }

    for (const uid in this.tags) {
      const tag = this.tags[uid]
      if (this.tags[tag.o.affiliatedTag]) {
        tag.afTag = this.tags[tag.o.affiliatedTag]
      }
    }

    return this.tags;
  }

  async loadPolicyRules() {
    await asyncNative.eachLimit(Object.values(this.tags), 50, id => id.loadPolicyAsync())
  }
}

const instance = new TagManager();
module.exports = instance;
