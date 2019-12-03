/*    Copyright 2016 Firewalla LLC
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

function formatBytes(bytes, decimals) {
  if (bytes == 0) return '0 Bytes';
  var k = 1000,
    dm = decimals || 2,
    sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
    i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

class DestInfoIntel extends Intel {

  async enrichAlarm(alarm) {
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

    if (!destIP) {
      return alarm;
    }

    // intel
    const intel = await intelTool.getIntel(destIP)
    if (intel && intel.app) {
      alarm["p.dest.app"] = intel.app
    }

    if (intel && intel.category) {
      // some alarm types are determined by combination of values in intel.category and intel.cs
      // there may be multiple categories in intel.cs, and p.dest.category should reflect the reason why this alarm is generated.
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
          alarm["p.dest.category"] = intel.category
      }

    }

    if (intel && intel.host) {
      alarm["p.dest.name"] = intel.host
    } else {
      alarm["p.dest.name"] = alarm["p.dest.name"] || alarm["p.dest.ip"];
    }

    // location
    if (intel && intel.country) {
      alarm["p.dest.country"] = intel.country; // FIXME: need complete location info
      intel.latitude && (alarm["p.dest.latitude"] = parseFloat(intel.latitude))
      intel.longitude && (alarm["p.dest.longitude"] = parseFloat(intel.longitude))
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
