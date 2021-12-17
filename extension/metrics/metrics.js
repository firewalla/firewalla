/*    Copyright 2021 Firewalla INC
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

const rclient = require('../../util/redis_manager.js').getRedisClient();

const log = require('../../net2/logger.js')(__filename);

const key = "metrics";
const _ = require('lodash');

let instance = null;

class Metrics {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  async incr(hkey) {
    await rclient.hincrbyAsync(key, hkey, 1);
  }

  async getMetrics() {
    return rclient.hgetallAsync(key);
  }

  async set(mkey, value) {
    if (mkey && value) {
      if (_.isObject(value))
        value = JSON.stringify(value);
      await rclient.hsetAsync(key, mkey, value);
    }
  }
}

module.exports = new Metrics();