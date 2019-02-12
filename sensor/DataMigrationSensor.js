/*    Copyright 2019 Firewalla LLC
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

const Sensor = require('./Sensor.js').Sensor;

const rclient = require('../util/redis_manager.js').getRedisClient();

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const ipTool = require('ip');

class DataMigrationSensor extends Sensor {
  constructor() {
    super();
  }

  run() {
    const migrationCodeNames = this.config.migrationCodeNames;
    if (migrationCodeNames && migrationCodeNames.constructor.name == "Array") {
      migrationCodeNames.forEach(codeName => {
        (async() => {
          const done = await this._is_migration_done(codeName);
          if (!done) {
            log.info("Start migration: " + codeName);
            await this._migrate(codeName);
            await this._set_migration_done(codeName);
          }
        })().catch((err) => {
          log.error("Failed to migrate, code name: " + codeName, err);
        });
      });
    }
  }

  async _is_migration_done(codeName) {
    const result = await rclient.getAsync("migration:" + codeName);
    if (result && result === "1") {
      return true;
    } else return false;
  }

  async _set_migration_done(codeName) {
    await rclient.setAsync("migration:" + codeName, "1");
  }

  async _migrate(codeName) {
    switch (codeName) {
      case "clairvoyant": // Device has nowhere to hide through mac address!
        const hosts = await hostTool.getAllIPs();
        hosts.forEach(async (host) => {
          const mac = host.mac;
          const ips = host.ips;
          for (let i in ips) {
            const ip = ips[i];
            log.info("Mac of " + ip + " is " + mac);
            if (mac) {
              let key = "flow:conn:in:" + ip;
              let dstKey = "flow:conn:in:" + mac;
              if (await rclient.existsAsync(key)) {
                await rclient.zunionstoreAsync([dstKey, 2, key, dstKey, "AGGREGATE", "MAX"]);
                await rclient.delAsync(key);
              }
  
              key = "flow:conn:out:" + ip;
              dstKey = "flow:conn:out:" + mac;
              if (await rclient.existsAsync(key)) {
                await rclient.zunionstoreAsync([dstKey, 2, key, dstKey, "AGGREGATE", "MAX"]);
                await rclient.delAsync(key);
              }
  
              key = "stats:hour:in:" + ip;
              dstKey = "stats:hour:in:" + mac;
              if (await rclient.existsAsync(key)) {
                await rclient.zunionstoreAsync([dstKey, 2, key, dstKey, "AGGREGATE", "MAX"]);
                await rclient.delAsync(key);
              }
  
              key = "stats:hour:out:" + ip;
              dstKey = "stats:hour:out:" + mac;
              if (await rclient.existsAsync(key)) {
                await rclient.zunionstoreAsync([dstKey, 2, key, dstKey, "AGGREGATE", "MAX"]);
                await rclient.delAsync(key);
              }
  
              key = "stats:last24:" + ip + ":upload";
              dstKey = "stats:last24:" + mac + ":upload";
              if (ipTool.isV4Format(ip) && (await rclient.existsAsync(key))) { // only handle ip v4 stats since hash merge is too complicated
                await rclient.renameAsync(key, dstKey);
              }
  
              key = "stats:last24:" + ip + ":download";
              dstKey = "stats:last24:" + mac + ":download";
              if (ipTool.isV4Format(ip) && (await rclient.existsAsync(key))) { // only handle ip v4 stats since hash merge is too complicated
                await rclient.renameAsync(key, dstKey);
              }
            }
          }
        });
        break;
      default:
        log.warn("Unrecognized code name: " + codeName);
    }
  }
}

module.exports = DataMigrationSensor;
