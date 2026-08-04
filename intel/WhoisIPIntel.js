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

        if (whoisInfo.country) {
          const country = Array.isArray(whoisInfo.country) ? whoisInfo.country[0] : whoisInfo.country;
          // discard country/city/org from whois if it is inconsistent with p.dest.country in alarm
          if (!alarm["p.dest.country"] || alarm["p.dest.country"] === country) {
            alarm["e.dest.ip.country"] = country;
            if(whoisInfo.city) {
              alarm["e.dest.ip.city"] = whoisInfo.city;
            }
            if(whoisInfo.orgName) {
              alarm["e.dest.ip.org"] = whoisInfo.orgName;
            }
          }      
        }
      }
    }
    
    return alarm;
  }

}

module.exports = WhoisIPIntel
