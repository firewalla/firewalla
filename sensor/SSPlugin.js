/*    Copyright 2016-2021 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename)

const Sensor = require('./Sensor.js').Sensor

const extensionManager = require('./ExtensionManager.js')

const configKey = "ext.ss.status";

const rclient = require('../util/redis_manager.js').getRedisClient();

class SSPlugin extends Sensor {
  async apiRun() {
    extensionManager.onGet("ssStatus", async (msg) => {
      const jsonString = await rclient.getAsync(configKey);
      if(!jsonString) {
        return {};
      }
      
      try {
        const content = JSON.parse(jsonString);
        return content;
      } catch(err) {
        log.error(`Got error when parsing json: ${jsonString}, err:`, err);
      }
    });
  }
}

module.exports = SSPlugin;
