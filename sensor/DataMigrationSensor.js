/*    Copyright 2016-2022 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient();

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const ipTool = require('ip');

class DataMigrationSensor extends Sensor {
  async run() {
    const previousMigrationCodeNames = await this._list_previous_migrations();
    const migrationCodeNames = this.config.migrationCodeNames;
    if (migrationCodeNames && migrationCodeNames.constructor.name == "Array") {
      // no need to do migration for previously recorded codenames
      const upgradeCodeNames = migrationCodeNames.filter((codeName) => {
        return !previousMigrationCodeNames.includes(codeName);
      })
      for (let codeName of upgradeCodeNames) {
        try {
          log.info("Start migration: " + codeName);
          await this._migrate(codeName);
          await this._set_migration_done(codeName);
          log.info("Migration complete: " + codeName);
        } catch (err) {
          log.error("Failed to migrate, code name: " + codeName, err);
        }
      }

      // rollback migrations that are previously done. This usually happens after version rollback
      const rollbackCodeNames = previousMigrationCodeNames.filter((code) => {
        return !migrationCodeNames.includes(code);
      });
      for (let codeName of rollbackCodeNames) {
        try {
          // looks like there should be symmetric rollback() function as an equivalent of migratie()?
          // but it is hardly useful since rollback code logic for a specific code name may also be reverted after rollback...
          await this._unset_migration_done(codeName);
        } catch (err) {
          log.error("Failed to rollback, code name: " + codeName, err);
        }
      }
    }
  }

  async _list_previous_migrations() {
    let migrations = await rclient.scanResults("migration:*");
    if (migrations && Array.isArray(migrations)) {
      migrations = migrations.map((migration) => {
        return migration.substring(10);
      });
    }
    return migrations || [];
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

  async _unset_migration_done(codeName) {
    await rclient.delAsync("migration:" + codeName);
  }

  async _migrate(codeName) {
    switch (codeName) {
      case "clairvoyant": // Device has nowhere to hide through mac address!
        const hosts = await hostTool.getAllIPs();
        for (const host of hosts) {
          const mac = host.mac;
          const ips = host.ips;
          for (const ip of ips) {
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
        };
        break;
      case "bipartite_graph": // many-to-many relationship between domain and ip is like a bipartite graph
        const dnsIpKeys = await rclient.scanResults("dns:ip:*");
        const now = Math.ceil(Date.now() / 1000);
        for (let dnsIpKey of dnsIpKeys) {
          const keyType = await rclient.typeAsync(dnsIpKey);
          const newDnsIpKey = `r${dnsIpKey}`; // new key is 'rdns:ip:xxxx'
          if (keyType === "zset") {
            await rclient.zunionstoreAsync([newDnsIpKey, 2, dnsIpKey, newDnsIpKey, "AGGREGATE", "MAX"]);
            await rclient.delAsync(dnsIpKey);
            await rclient.expireAsync(newDnsIpKey, 86400);
            continue;
          }
          if (keyType !== "hash")
            continue;
          const dnsEntry = await rclient.hgetallAsync(dnsIpKey);
          await rclient.delAsync(dnsIpKey);
          const ip = dnsIpKey.substring(7);
          if (!ipTool.isV4Format(ip) && !ipTool.isV6Format(ip))
            continue;
          if (dnsEntry && dnsEntry.host) {
            await rclient.zaddAsync(newDnsIpKey, dnsEntry.lastActive || now, dnsEntry.host);
            await rclient.expireAsync(newDnsIpKey, 86400);
          }
        }
        break;
      default:
        log.warn("Unrecognized code name: " + codeName);
    }
  }
}

module.exports = DataMigrationSensor;
