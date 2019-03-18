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

class WhoisIPIntel extends Intel {

  async enrichAlarm(alarm) {
    const destIP = alarm["p.dest.ip"];

    if(destIP) {
      const whoisInfo = await intelManager.whois(destIP).catch((err) => {
        return {}
      });

      if(whoisInfo) {
        if(whoisInfo.netRange) {
          alarm["e.dest.ip.range"] = whoisInfo.netRange;
        }

        if(whoisInfo.cidr) {
          alarm["e.dest.ip.cidr"] = whoisInfo.cidr;
        }

        if(whoisInfo.orgName) {
          alarm["e.dest.ip.org"] = whoisInfo.orgName;
        }

        if(whoisInfo.country) {
          if(Array.isArray(whoisInfo.country)) {
            alarm["e.dest.ip.country"] = whoisInfo.country[0];
          } else {
            alarm["e.dest.ip.country"] = whoisInfo.country;
          }          
        }

        if(whoisInfo.city) {
          alarm["e.dest.ip.city"] = whoisInfo.city;
        }
      }
    }
    
    return alarm;
  }

}

module.exports = WhoisIPIntel
