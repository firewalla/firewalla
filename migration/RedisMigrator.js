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
 const readline = require('readline');

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
    "sys:features",
    "mode",
    "dhcp:static"
  ],
  "intel": [
    "category:*",
    "dynamicCategoryDomain:*",
    "ipmapping:*",
    "intel:*",
    "lastCategory:*",
    "cache.intel:*",
    "rdns:*",
    "dns:*",
    "srdns:*",
    "ip_set_to_be_processed",
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

  async _serializeRedisKey(key) {
    let result = "";
    const keyDump = await bclient.dumpAsync(key);
    if (keyDump !== null) {
      const ttl = await bclient.pttlAsync(key); // in milliseconds
      const record = {
        key: key.toString(),
        ttl: ttl,
        value: keyDump
      };
      result = JSON.stringify(record) + "\n";  
    }
    return result;
  }

  async _deserializeRedisKey(record) {
    if (record !== "") {
      const recordJson = JSON.parse(record);
      const key = recordJson.key;
      const ttl = Math.max(0, recordJson.ttl);
      const value = Buffer.from(recordJson.value.data);
      await bclient.restoreAsync(key, ttl, value, "REPLACE");
    }
  }

  async export(partition, outputStream) {
    const keyPatterns = partitionKeyMap[partition];
    if (keyPatterns !== null) {
      for (let i in keyPatterns) {
        const pattern = keyPatterns[i];
        const keys = await bclient.keysAsync(pattern);
        log.info("Pattern: " + pattern + ", number of keys to dump: " + keys.length);
        while (keys.length > 0) {
          // concurrency limit
          const keysBatch = keys.splice(0, 4);
          await Promise.all(keysBatch.map(async key => {
            const serializedData = await this._serializeRedisKey(key);
            outputStream.write(Buffer.from(serializedData));
          }));
        }
        if (global.gc)
          global.gc();
      }
    }
    outputStream.end();
  }

  async import(inputStream) {
    const lineReader = readline.createInterface({
      input: inputStream
    });
    return new Promise((resolve, reject) => {
      lineReader.on('line', (line) => {
        this._deserializeRedisKey(line);
      });
      lineReader.on('close', () => {
        if (global.gc)
          global.gc();
        resolve();
      })
    })
  }
}

module.exports = RedisMigrator;