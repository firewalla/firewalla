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

class SSLIntel extends Intel {
  async enrichAlarm(alarm) {
    const IntelTool = require('../net2/IntelTool.js');
    const intelTool = new IntelTool();

    let ip = alarm["p.dest.ip"];
    if (ip) {
      try {
        let sslInfo = await (intelTool.getSSLCertificate(ip));
        log.info("Get ssl info of " + ip + ": " + sslInfo);
        if (sslInfo) {
          for (var key in sslInfo) {
            let detailKey = "e.dest.ssl." + key;
            alarm[detailKey] = sslInfo[key];
          }
        }
      } catch (err) {
          log.error("Failed to get ssl cert info: " + err);
      }
    }
    return alarm;
  }
}

module.exports = SSLIntel;