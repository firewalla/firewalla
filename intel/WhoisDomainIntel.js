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

class WhoisDomainIntel extends Intel {

  async enrichAlarm(alarm) {
    const name = alarm["p.dest.name"];

    if(name) {
      const whoisInfo = await intelManager.whois(name).catch((err) => {
        return {}
      });

      if(whoisInfo) {
        if(whoisInfo.domainName) {
          const domainName = whoisInfo.domainName + "";
          alarm["e.dest.domain"] = domainName.toLowerCase();
          alarm["p.dest.domain"] = domainName.toLowerCase();
        }

        if(whoisInfo.creationDate) {
          alarm["e.dest.domain.createdDate"] = whoisInfo.creationDate;
        }

        if(whoisInfo.updatedDate) {
          alarm["e.dest.domain.lastUpdatedDate"] = whoisInfo.updatedDate;
        }

        if(whoisInfo.registrar) {
          alarm["e.dest.domain.register"] = whoisInfo.registrar;
        }
      }
    }

    return alarm;
  }

}

module.exports = WhoisDomainIntel
