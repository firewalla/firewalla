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
const rp = require('request-promise');

const iptool = require('ip');

class Cymon2Intel extends Intel {

  async enrichAlarm(alarm) {
    const ip = alarm["p.dest.ip"];
    const type = alarm["type"];

    if(ip && type === 'ALARM_INTEL') { // only enrich intel alarms
      const result = await this.loadFromCymon(ip);
      if(result["total"] !== undefined) {
        alarm["p.security.numOfReportSources2"] = result["total"];
      }
    }

    return alarm;
  }
  
  async loadFromCymon(ip) {
    
    if(!ip) {
      return;
    }
    
    if(!iptool.isV4Format(ip)) { // only support v4 yet..
      return;
    }
    
    const uri = `https://api.cymon.io/v2/ioc/search/ip/${ip}`
    
    const body = await rp({
      uri: uri,
      method: 'GET',
      family: 4,
      json: true,
      timeout: 10000 //ms
    }).catch((err) => {
      log.error("Failed to request info from cymon, err:", err);
      return null;
    });
    
    return body;
  }

}

module.exports = Cymon2Intel;
