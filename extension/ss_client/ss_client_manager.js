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
const ssActiveConfigKey = "scisurf.config.active";

class SSClientManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.clients = [];
    }
    return instance;
  }

  async getAllConfigs() {
    const configString = await rclient.getAsync(ssConfigKey);
    if(!configString) {
      return [];
    }

    try {
      let config = JSON.parse(configString);
      if(config.servers && Array.isArray(config.servers)) {
        return config.servers;
      } else {
        return [config];
      }
    } catch(err) {
      log.error(`Failed to load ss config ${ssConfigKey}, err:`, err);
      return [];
    }
  }

  async resetSSClients() {
    // TODO
  }

  async initSSClients() {
    if(this.inited) {
      return;
    }

    const configs = await this.getAllConfigs();
    let basePort = 9100;
    for(const config of configs) {
      config.name = config.name || `${config.server}:${config.server_port}`;

      const client = new SSClient(Object.assign({}, config, {
        name: config.name,
        overturePort: basePort,
        ssRedirectPort: basePort + 1,
        ssClientPort: basePort + 2
      }));
      this.clients.push(client);
      basePort += 10;
    }
  }

  async startService() {
    for(const client of this.clients) {
      await client.start();
    }
  }

  async stopService() {
    for(const client of this.clients) {
      await client.stop();
    }
  }

  async selectClient() {
    return 0;
  }

  async startRedirect() {
    const index = await this.selectClient();
    const client = this.clients[index];
    if(client) {
      await client.redirectTraffic();
    } else {
      log.error(`Invalid client index: ${index}`);
    }
  }

  async stopRedirect() {
    const index = await this.selectClient();
    const client = this.clients[index];
    if(client) {
      await client.unredirectTraffic();
    } else {
      log.error(`Invalid client index: ${index}`);
    }
  }
}

module.exports = new SSClientManager();
