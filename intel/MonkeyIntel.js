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

const rclient = require('../util/redis_manager.js').getRedisClient();

const monkeyPrefix = "monkey";

class MonkeyIntel extends Intel {

  async enrichAlarm(alarm) {
    const destIP = alarm["p.dest.ip"];

    if(destIP) {
      const key = `${monkeyPrefix}:${destIP}`
      const type = await rclient.typeAsync(key);
      if(type !== 'none') {
        alarm["p.monkey"] = 1;
      }
    }

    return alarm;
  }

}

module.exports = MonkeyIntel
