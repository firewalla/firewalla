/*    Copyright 2016-2021 Firewalla Inc.
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


/*
 * 2.2.15 RemoteHost
 *
 * This variable represents the source of inbound IP packets. This will be a wildcard in most cases
 * (i.e. an empty string). NAT vendors are only required to support wildcards. A non-wildcard value
 * will allow for “narrow” port mappings, which may be desirable in some usage scenarios.When
 * RemoteHost is a wildcard, all traffic sent to the ExternalPort on the WAN interface of the
 * gateway is forwarded to the InternalClient on the InternalPort. When RemoteHost is
 * specified as one external IP address as opposed to a wildcard, the NAT will only forward inbound
 * packets from this RemoteHost to the InternalClient, all other packets will be dropped.
 *
 * http://upnp.org/specs/gw/UPnP-gw-WANIPConnection-v1-Service.pdf
 */

'use strict';
const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;
const sem = require('./SensorEventManager').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()

const UPNP = require('../extension/upnp/upnp.js');
const upnp = new UPNP();

const cfg = require('../net2/config.js');

const sysManager = require('../net2/SysManager.js');
const Message = require('../net2/Message.js');
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const platform = require('../platform/PlatformLoader.js').getPlatform();
const fs = require('fs');
const exec = require('child-process-promise').exec;

const _ = require('lodash');

const ALARM_UPNP = 'alarm_upnp';

function compareUpnp(a, b) {
  return a.public && b.public &&
    a.private && b.private &&
    a.public.port == b.public.port &&
    a.private.host == b.private.host &&
    a.private.port == b.private.port &&
    a.protocol == b.protocol;
}

class UPNPSensor extends Sensor {
  constructor(config) {
    super(config);
    this.upnpLeaseFileWatchers = [];
  }

  isExpired(mapping) {
    const retentionPeriod = this.config.expireInterval || 1800;
    return !mapping.lastSeen || mapping.lastSeen < (Math.floor(Date.now() / 1000) - retentionPeriod) || (mapping.expire && mapping.expire < Math.floor(Date.now() / 1000));
  }

  mergeResults(curMappings, preMappings) {

    curMappings.forEach((mapping) => {
      mapping.expire = (mapping.ttl && mapping.ttl > 0) ? Math.floor(Date.now() / 1000) + mapping.ttl : null;
      mapping.lastSeen = Math.floor(Date.now() / 1000);
    });

    const fullMappings = [...preMappings, ...curMappings]; // uniqWith will keep the first occurrence of duplicate elements, preMappings may contain extra keys that do not exist in curMappings, e.g., ts

    const uniqMappings = _.uniqWith(fullMappings, compareUpnp);

    return uniqMappings
      .filter((mapping) => !this.isExpired(mapping));
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(async () => {
      // UPnP lease file only exists on FireRouter enabled devices
      if (!platform.isFireRouterManaged())
        return;
      for (const watcher of this.upnpLeaseFileWatchers) {
        watcher.close();
      }
      this.upnpLeaseFileWatchers = [];
      const monitoringInterfaces = sysManager.getMonitoringInterfaces();
      for (const iface of monitoringInterfaces) {
        if (iface.name && iface.name.endsWith(":0"))
          continue;
        const leaseFile = `/var/run/upnp.${iface.name}.leases`;
        await exec(`sudo touch ${leaseFile}`).then(() => {
          const watcher = fs.watch(leaseFile, {}, (e, filename) => {
            if (e === "change") {
              log.info(`UPnP lease file ${leaseFile} is changed, schedule checking UPnP leases ...`);
              this.scheduleCheckUPnPLeases();
            }
            if (e === "rename") {
              log.info(`UPnP lease file ${leaseFile} is renamed, schedule reload UPNPSensor ...`);
              this.scheduleReload();
            }
          });
          log.info(`Watching UPnP lease file change on ${leaseFile} ...`);
          this.upnpLeaseFileWatchers.push(watcher);
        }).catch((err) => {
          log.error(`Failed to watch file change ${leaseFile}`, err.message);
        });
      }
      this.scheduleCheckUPnPLeases();
    }, 5000);
  }

  scheduleCheckUPnPLeases() {
    if (this.checkTask)
      clearTimeout(this.checkTask);
    this.checkTask = setTimeout(() => {
      this._checkUpnpLeases().catch((err) => {
        log.error(`Error occurred while check UPnP leases`, err.message);
      });
    }, 3000);
  }

  async _checkUpnpLeases() {
    let results = await upnp.getPortMappingsUPNP().catch((err) => {
      log.error(`Failed to get UPnP mappings`, err);
      return [];
    });

    if (!results) {
      results = []
      log.info("No upnp mapping found in network");
    }

    const key = "sys:scan:nat";

    try {
      let entries = await rclient.hgetAsync(key, 'upnp');
      let preMappings = JSON.parse(entries) || [];

      const mergedResults = this.mergeResults(results, preMappings);

      if (cfg.isFeatureOn(ALARM_UPNP)) {
        for (let current of mergedResults) {
          let firewallaRegistered = sysManager.isMyIP(current.private.host) &&
            upnp.getRegisteredUpnpMappings().some(m => upnp.mappingCompare(current, m));

          if (
            !firewallaRegistered &&
            !preMappings.some(pre => compareUpnp(current, pre))
          ) {
            const now = Math.ceil(Date.now() / 1000);
            current.ts = now;
            let alarm = new Alarm.UpnpAlarm(
              now,
              current.private.host,
              {
                'p.source': 'UPNPSensor',
                'p.device.ip': current.private.host,
                'p.upnp.public.host': current.public.host,
                'p.upnp.public.port': current.public.port.toString(),
                'p.upnp.private.host': current.private.host,
                'p.upnp.private.port': current.private.port.toString(),
                'p.upnp.protocol': current.protocol,
                'p.upnp.enabled': current.enabled.toString(),
                'p.upnp.description': current.description,
                'p.upnp.ttl': current.ttl.toString(),
                'p.upnp.expire': current.expire ? current.expire.toString() : null,
                'p.upnp.local': current.local.toString(),
                'p.device.port': current.private.port.toString(),
                'p.protocol': current.protocol
              }
            );
            am2.enqueueAlarm(alarm);
          }
        }
      }

      if (await rclient.hmsetAsync(key, { upnp: JSON.stringify(mergedResults) }))
        log.info("UPNP mapping is updated,", mergedResults.length, "entries");

    } catch (err) {
      log.error("Failed to scan upnp mapping: " + err);
    }
  }

  run() {
    sem.once('IPTABLES_READY', () => {
      this.scheduleReload();

      sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
        log.info("Schedule reload UPNPSensor since network info is reloaded");
        this.scheduleReload();
      })

      setInterval(() => {
        this.scheduleCheckUPnPLeases();
      }, this.config.interval * 1000 || 60 * 10 * 1000); // default to 10 minutes
    });
  }
}

module.exports = UPNPSensor;
