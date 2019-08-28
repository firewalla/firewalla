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

'use strict';

let instance = null;
const log = require('../../net2/logger.js')(__filename);

const SSClient = require('./ss_client.js');
const rclient = require('../../util/redis_manager').getRedisClient();

const ssConfigKey = "scisurf.config";

class SSClientManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.ssClientMap = {};
    }
    return instance;
  }

  async getConfig(name = "default") {
    let key = `${ssConfigKey}`;
    if(name !== "default") {
      key = `scisurf.${name}.config`;
    }
    const configString = await rclient.getAsync(key);
    if(!configString) {
      return null;
    }
    
    try {
      let config = JSON.parse(configString);
      if(config.servers && Array.isArray(config.servers)) {
        if(config.servers.length === 0) {
          return null;
        } else {
          config = config.servers[0];
        }
      }
      return config;
    } catch(err) {
      log.error(`Failed to load ss config ${key}, err:`, err);
      return null;
    }
  }

  async getSSClient(name = "default") {
    if(!this.ssClientMap[name]) {
      let config = await this.getConfig(name);
      if(config) {
        this.ssClientMap[name] = new SSClient(Object.assign({}, config, {name}));
      } else {
        return null;
      }
    }

    return this.ssClientMap[name];
  }
}

module.exports = new SSClientManager();
