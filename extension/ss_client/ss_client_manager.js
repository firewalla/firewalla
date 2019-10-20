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

const sem = require('../../sensor/SensorEventManager.js').getInstance();

const SSClient = require('./ss_client.js');
const rclient = require('../../util/redis_manager').getRedisClient();

const ssConfigKey = "scisurf.config";
const ssActiveConfigKey = "scisurf.config.active";
const errorClientExpireTime = 3600;
const statusCheckInterval = 3 * 60 * 1000; // check every 3 minutes

class SSClientManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.clients = [];
      this.errorClients = {};
      this.curIndex = 0;
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

    this.curIndex = Math.floor(Math.random() * this.clients.length); // random start
    setInterval(() => {
      this.statusCheck();
    }, statusCheckInterval);

    setTimeout(() => {
      this.statusCheck();
    }, 1000 * 30); // fast check in 30 seconds
  }

  async stopService() {
    for(const client of this.clients) {
      await client.stop();
    }
  }

  async startRedirect() {
    const client = this.getCurrentClient();
    if(client) {
      await client.redirectTraffic();
    } else {
      log.error(`Invalid client index: ${index}`);
    }
  }

  async stopRedirect() {
    const client = this.getCurrentClient();
    if(client) {
      await client.unRedirectTraffic();
    } else {
      log.error(`Invalid client index: ${index}`);
    }
  }

  getCurrentClient() {
    return this.clients[this.curIndex];
  }

  async statusCheck() {
    this.cleanupErrorList();

    const client = this.getCurrentClient();
    const result = await client.statusCheck();
    if(!result) {
      log.error(`ss client ${client.name} is down, taking out from the pool`);
      // add it to error queue
      this.errorClients[client.name] = Math.floor(new Date() / 1000);

      this.sendSSDownNotification(client);

      await this.stopRedirect();

      const moveNext = this.moveToNextClient();
      if(moveNext) {
        await this.startRedirect();
      }
    }

    await this.printStatus();
  }

  sendSSDownNotification(client) {
    sem.sendEventToFireApi({
      type: 'FW_NOTIFICATION',
      titleKey: 'FW_SS_DOWN_TITLE',
      bodyKey: 'FW_SS_DOWN_BODY',
      titleLocalKey: 'FW_SS_DOWN_TITLE',
      bodyLocalKey: 'FW_SS_DOWN_BODY',
      bodyLocalArgs: [client.name],
      payload: {
        clientName: client.name
      }
    });
  }

  moveToNextClient(tryCount = 0) {
    if(tryCount > 100) {
      return false;
    }

    const cur = this.curIndex;
    const validClients = this.getValidClients();
    if(validClients.length === 0) {
      log.error("No more available clients!!");
      return false;
    }
    const randomIndex = Math.floor(Math.random() * validClients.length);
    const selectedClient = validClients[randomIndex];
    const selectedIndex = this.getIndexByName(selectedClient.name);
    if(selectedIndex === null) {
      this.errorClients[selectedClient.name] = Math.floor(new Date() / 1000);
      log.error(`Failed to find the selected client ${selectedClient.name}, trying again`);
      return this.moveToNextClient(tryCount+1);
    }

    this.curIndex = selectedIndex;

    return true;
  }

  getIndexByName(name) {
    for(const index in this.clients) {
      const client = this.clients[index];
      if(client.name === name) {
        return index;
      }
    }

    return null;
  }

  async printStatus() {
    const total = this.clients.length;
    const offline = Object.keys(this.errorClients).length;
    const online = this.clients.length - offline;
    const activeName = this.getCurrentClient().name;
    log.info(`${total} ss clients, ${online} clients are online, ${offline} clients are offline, active: ${activeName}.`);
  }

  cleanupErrorList() {
    for(const clientName in this.errorClients) {
      const time = this.errorClients[clientName];
      const now = Math.floor(new Date() / 1000);
      if(now - time > errorClientExpireTime) {
        delete this.errorClients[clientName];
      }
    }
  }

  getValidClients() {
    const list = [];

    for(const client of this.clients) {
      const name = client.name;
      if(!this.errorClients.includes(name)) {
        list.push(client);
      }
    }

    return list;
  }
}

module.exports = new SSClientManager();
