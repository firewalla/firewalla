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

class UAIntel extends Intel {
  async enrichAlarm(alarm) {
    const IntelTool = require('../net2/IntelTool.js');
    const intelTool = new IntelTool();

    let src = alarm["p.device.ip"];
    let dst = alarm["p.dest.ip"];
    let dstPort = alarm["p.dest.port"];
    if (src && dst) {
      try {
        let uaInfo = await intelTool.getUserAgent(src, dst, dstPort);
        log.info("Get user agent info of " + src + "->" + dst + ":" + dstPort + ": " + uaInfo);
        if (uaInfo) {
          alarm["e.userAgent"] = uaInfo;
        }
      } catch (err) {
          log.error("Failed to get user agent info: " + err);
      }
    }
    return alarm;
  }
}

module.exports = UAIntel;