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

const IntelManager = require('../net2/IntelManager.js')
const intelManager = new IntelManager('info');

class IPLocationIntel extends Intel {

  async enrichAlarm(alarm) {
    const destIP = alarm["p.dest.ip"];

    if(destIP) {
      // location
      const loc = await intelManager.ipinfo(destIP)
      if (loc && loc.loc) {
        const location = loc.loc;
        const ll = location.split(",");
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

module.exports = IPLocationIntel
