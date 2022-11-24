/*    Copyright 2019-2020 Firewalla Inc.
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
//const bone = require("../lib/Bone.js");
const { rrWithErrHandling } = require('./requestWrapper.js')

class IpInfo {

  async get(ip) {
    const options = {
      uri: "http://ipinfo.io/" + ip,
      method: 'GET',
      timeout: 2000, // ms
      json: true,
      maxAttempts: 3,
      retryDelay: 1000,  // (default) wait for 1s before trying again
    };

    try {
      log.info("Request ipinfo for ip:", ip);
      const resp = await rrWithErrHandling(options);
      log.debug("ipInfo from ipinfo is:", resp.body);
      return resp.body;
    } catch (err) {
      log.error(err.message);
      log.debug(err.stack)
      return null
    }
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
