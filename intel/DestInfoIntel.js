/*    Copyright 2016-2020 Firewalla Inc.
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

const Intel = require('./Intel.js');

const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()

const IntelManager = require('../net2/IntelManager.js')
const intelManager = new IntelManager();

const sysManager = require('../net2/SysManager.js');
const DNSManager = require('../net2/DNSManager.js');
const dnsManager = new DNSManager('info');
const getPreferredName = require('../util/util.js').getPreferredName
const f = require('../net2/Firewalla.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('../net2/Message.js');
const Constants = require('../net2/Constants.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const DomainTrie = require('../util/DomainTrie.js');
const _ = require('lodash');

function formatBytes(bytes, decimals) {
  if (bytes == 0) return '0 Bytes';
  var k = 1000,
    dm = decimals || 2,
    sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
    i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

class DestInfoIntel extends Intel {

  constructor() {
    super();
    this.reloadAppIntelConfig().catch((err) => {
      log.error(`Failed to reload app intel config`, err.message);
    });
    sem.on(Message.MSG_APP_INTEL_CONFIG_UPDATED, async (event) => {
      this.reloadAppIntelConfig().catch((err) => {
        log.error(`Failed to reload app intel config`, err.message);
      });  
    });
  }

  async reloadAppIntelConfig() {
    const data = await rclient.getAsync(Constants.REDIS_KEY_APP_TIME_USAGE_CLOUD_CONFIG).then(result => result && JSON.parse(result)).catch(err => null);
    this.appConfig = data;
    this.rebuildTrie();
  }

  rebuildTrie() {
    const appConfs = _.get(this.appConfig, "appConfs", {});
    const domainTrie = new DomainTrie();
    for (const app of Object.keys(appConfs)) {
      const intelDomains = appConfs[app].intelDomains || [];
      for (const domain of intelDomains) {
        if (domain.startsWith("*.")) {
          domainTrie.add(domain.substring(2), app);
        } else {
          domainTrie.add(domain, app, false);
        }
      }
    }
    this._domainTrie = domainTrie;
  }

  lookupApp(domain) {
    if (!domain || !this._domainTrie)
      return null;
    const values = this._domainTrie.find(domain);
    if (_.isSet(values) && !_.isEmpty(values))
      return values.values().next().value;
    return null;
  }

  async enrichAlarm(alarm) {
    if (alarm["p.ignoreDestIntel"] == "1")
      return alarm;
    if (alarm["p.transfer.outbound.size"]) {
      alarm["p.transfer.outbound.humansize"] = formatBytes(alarm["p.transfer.outbound.size"]);
    }

    if (alarm["p.transfer.inbound.size"]) {
      alarm["p.transfer.inbound.humansize"] = formatBytes(alarm["p.transfer.inbound.size"]);
    }
    if (alarm["p.totalUsage"]) {
      alarm["p.totalUsage.humansize"] = formatBytes(alarm["p.totalUsage"]);
    }
    if (alarm["p.planUsage"]) {
      alarm["p.planUsage.humansize"] = formatBytes(alarm["p.planUsage"]);
    }

    let destIP = alarm["p.dest.ip"];
    const destName = alarm["p.dest.name"];

    if (!destIP) {
      return alarm;
    }
    if (sysManager.isLocalIP(destIP)) {
      try {
        if (sysManager.isMyIP(destIP) || sysManager.isMyIP6(destIP)) {
          Object.assign(alarm, {
            "p.dest.name": await f.getBoxName() || "Firewalla",
            "p.dest.macVendor": "FIREWALLA INC",
            "p.dest.isLocal": "1"
          })
        } else {
          const result = await dnsManager.resolveLocalHostAsync(destIP);
          Object.assign(alarm, {
            "p.dest.name": getPreferredName(result),
            "p.dest.id": result.mac,
            "p.dest.mac": result.mac,
            "p.dest.macVendor": result.macVendor || "Unknown",
            "p.dest.isLocal": "1"
          });
        }
      } catch (err) {
        log.error("Failed to find host " + destIP + " in database: " + err);
      }
      return alarm;
    }

    const app = this.lookupApp(destName);
    if (app)
      alarm["p.dest.app"] = _.get(this.appConfig, ["appConfs", app, "displayName"]);

    // intel
    const intel = await intelTool.getIntel(destIP, (destName && destName !== destIP) ? [destName] : []);

    switch (alarm["type"]) {
      case 'ALARM_VIDEO':
        alarm["p.dest.category"] = 'av';
        break;
      case 'ALARM_GAME':
        alarm["p.dest.category"] = 'games';
        break;
      case 'ALARM_PORN':
        alarm["p.dest.category"] = 'porn';
        break;
      default:
        // some alarm types are determined by combination of values in intel.category and intel.cs
        // there may be multiple categories in intel.cs, and p.dest.category should reflect the reason why this alarm is generated.
        if (intel && intel.category)
          alarm["p.dest.category"] = intel.category;
    }

    if (intel && intel.host && alarm["p.dest.name"] === alarm["p.dest.ip"]) { // do not change p.dest.name if it is already a domain, host in intel:ip may be incorrect in case of cache conflict
      alarm["p.dest.name"] = intel.host
    } else {
      alarm["p.dest.name"] = alarm["p.dest.name"] || alarm["p.dest.ip"];
    }

    // location
    if (intel && intel.country && intel.latitude && intel.longitude) {
      alarm["p.dest.country"] = intel.country; // FIXME: need complete location info
      alarm["p.dest.latitude"] = parseFloat(intel.latitude)
      alarm["p.dest.longitude"] = parseFloat(intel.longitude)
    } else {
      const loc = await intelManager.ipinfo(destIP)
      if (loc && loc.loc) {
        const ll = loc.loc.split(",");
        if (ll.length === 2) {
          alarm["p.dest.latitude"] = parseFloat(ll[0]);
          alarm["p.dest.longitude"] = parseFloat(ll[1]);
        }
        alarm["p.dest.country"] = loc.country; // FIXME: need complete location info
      }
    }

    return alarm;
  }

}

module.exports = DestInfoIntel
