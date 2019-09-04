/*    Copyright 2019 Firewalla INC
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

const log = require("../net2/logger.js")(__filename);
const rp = require('request-promise');
//const bone = require("../lib/Bone.js");

class IpInfo {

  async get(ip) {
    const options = {
      uri: "http://ipinfo.io/" + ip,
      method: 'GET',
      timeout: 2000, // ms
      json: true,
    };

    let retry = 3;
    let result = null;
    do {
      try {
        log.info("Request ipinfo for ip:", ip);
        result = await rp(options);
      } catch (err) {
        log.error("Error while requesting", options.uri, err.code, err.message, err.stack);
      }
    } while (!result && retry -- > 0);

    log.info("ipInfo from ipinfo is:", result);
    return result;
  }

  /*
  async getFromBone(ip) {
    let result = await bone.intelFinger(ip);
    if (result) {
      log.info("ipInfo from bone is:", result.ipinfo);
      return result.ipinfo;
    }
    log.info("ipInfo from bone is:", null);
    return null;
  }
  */
  
}

module.exports = new IpInfo();
