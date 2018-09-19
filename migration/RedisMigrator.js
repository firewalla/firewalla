/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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
 const util = require('util');
 const DataMigrator = require('./DataMigrator.js');
 let instance = null;

 const bclient = require('../util/redis_manager.js').getBufferRedisClient();

 const partitionKeyMap = {
  "devices": [
    "host:*"
  ],
  "alarms": [
    "alarm:id",
    "_alarm:*",
    "_alarmDetail:*",
    "alarm_active",
    "alarm_archive"
  ],
  "rules": [
    "policy:id",
    "policy_active",
    "policy:*"
  ],
  "exceptions": [
    "exception:id",
    "exception:*",
    "exception_queue"
  ],
  "config": [
    "policy:system",
    "policy:mac:*",
    "ext.*",
    "scisurf.config",
    "sys:features",
    "mode"
  ],
  "intel": [
    "category:*",
    "dynamicCategoryDomain:*",
    "intel:*",
    "lastCategory:*",
    "cache.intel:*",
    "rdns:*",
    "dns:*",
    "srdns:*",
    "ip_set_to_be_processed",
    "software:ip:*",
    "user_agent:*",
    "app:*",
    "lastapp:*",
    "dhcp:*"
  ],
  "traffic": [
    "flow:*",
    "aggrflow:*",
    "appflow:*",
    "sumflow:*",
    "syssumflow:*",
    "lastsumflow:*",
    "categoryflow:*",
    "timedTraffic:*"
  ],
  "stats": [
    "boneAPIUsage:*",
    "neighbor:*",
    "stats:*"
  ],
  "mq": [
    "bq:*"
  ],
  "misc": [
    "monitored_hosts*",
    "unmonitored_hosts*",
    "zoffline_hosts"
  ]
};

class RedisMigrator extends DataMigrator {
  constructor() {
    super();
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  async _serializeRedisKeys(keyPattern) {
    let result = "";
    const keys = await bclient.keysAsync(keyPattern);
    await Promise.all(keys.map(async key => {
      const keyDump = await bclient.dumpAsync(key);
      const ttl = await bclient.pttlAsync(key); // in milliseconds
      const record = {
        key: key.toString(),
        ttl: ttl,
        value: JSON.parse(JSON.stringify(keyDump)).data
      };
      result = result + JSON.stringify(record) + "\n";
    }));
    return result;
  }

  async _deserializeRedisKeys(dump) {
    const records = dump.split("\n");
    await Promise.all(records.map(async record => {
      if (record !== "") {
        const recordJson = JSON.parse(record);
        const key = recordJson.key;
        const ttl = Math.max(0, recordJson.ttl);
        const value = Buffer.from(recordJson.value);
        await bclient.restoreAsync(key, ttl, value, "REPLACE");
      }
    }));
  }

  async export(partition) {
    const keyPatterns = partitionKeyMap[partition];
    let dump = "";
    if (keyPatterns !== null) {
      await Promise.all(keyPatterns.map(async pattern => {
        const serializedData = await this._serializeRedisKeys(pattern);
        dump = dump + serializedData;
      }));
    }
    const buffer = Buffer.from(dump);
    return buffer;
  }

  async import(buffer) {
    const dump = buffer.toString("utf8");
    await this._deserializeRedisKeys(dump);
  }
}

module.exports = RedisMigrator;