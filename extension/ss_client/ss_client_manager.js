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

'use strict';

let instance = null;
const log = require('../../net2/logger.js')(__filename);

const sem = require('../../sensor/SensorEventManager.js').getInstance();

const SSClient = require('./ss_client.js');
const rclient = require('../../util/redis_manager').getRedisClient();

const ssConfigKey = "scisurf.config";
const ssActiveConfigKey = "scisurf.config.active";
const errorClientExpireTime = 3600;
const statusCheckInterval = 1 * 60 * 1000;

const _ = require('lodash');

const exec = require('child-process-promise').exec;

class SSClientManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.clients = [];
      this.errorClients = {};
      this.curIndex = 0;
      this.allDown = false;
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
        return config.servers; //.slice(0, 1);
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

  async stopAllSSServices() {
    return exec("sudo systemctl stop 'ss_client@*'");
  }

  async initSSClients() {
    if(this.inited) {
      return;
    }

    await this.stopAllSSServices().catch((err) => {});

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
    try {
      const client = this.getCurrentClient();
      log.info(`Using ${client.name} as primary ss client.`);
      await client.redirectTraffic();
    } catch(err) {
      log.error(`Failed to redirect traffic, client index: ${this.curIndex}`, err);
    }
  }

  async stopRedirect() {
    const client = this.getCurrentClient();
    if(client) {
      await client.unRedirectTraffic();
    } else {
      log.error(`Invalid client index: ${this.curIndex}`);
    }
  }

  getCurrentClient() {
    return this.clients[this.curIndex];
  }

  async statusCheck() {
    this.cleanupErrorList();

    const totalStatusResult = this.clients.map(s => {
      const status = s.statusCheckResult;
      const config = s.config;
      const name = s.name;
      return {status, config, name};
    });
    await rclient.setAsync("ext.ss.status", JSON.stringify(totalStatusResult));

    await this._statusCheck();

    const client = this.getCurrentClient();
    const result = client.statusCheckResult;
    if(result && result.status === false) {
      log.error(`ss client ${client.name} is down, taking out from the pool`);
      // add it to error queue
      this.errorClients[client.name] = Math.floor(new Date() / 1000);

      await this.stopRedirect();

      const moveNext = this.moveToNextClient();
      if(moveNext) {
        await this.startRedirect();
        this.sendSSFailOverNotification(client, this.getCurrentClient());
      } else {
        this.sendSSDownNotification(client);
        this.allDown = true;
      }
    } else {
      if(this.allDown) {
        await this.startRedirect();
        this.allDown = false;
      }
    }

    await this.printStatus();
  }

  async _statusCheck() {
    const cmd = `dig @8.8.8.8 +tcp google.com +time=3 +retry=2`;
    log.info("checking cmd", cmd);
    try {
      const result = await exec(cmd);
      if(result.stdout) {
        const queryTimeMatches = result.stdout.split("\n").filter((x) => x.match(/;; Query time: \d+ msec/));
        if(!_.isEmpty(queryTimeMatches)) {
          const m = queryTimeMatches[0];
          const mr = m.match(/;; Query time: (\d+) msec/);
          if(mr[1]) {
            const time = mr[1];
            return {
              time: Number(time),
              status: true
            };
          }
        }
      }
    } catch(err) {
      log.error(`ss server ${this.name} is not available.`, err);
    }
    return {
      status: false
    };
  }

  sendSSDownNotification(client) {
    sem.sendEventToFireApi({
      type: 'FW_NOTIFICATION',
      titleKey: 'FW_SS_DOWN_TITLE',
      bodyKey: 'FW_SS_DOWN_BODY',
      titleLocalKey: 'FW_SS_DOWN',
      bodyLocalKey: 'FW_SS_DOWN',
      bodyLocalArgs: [client.name],
      payload: {
        clientName: client.name
      }
    });
  }

  sendSSFailOverNotification(client, newClient) {
    sem.sendEventToFireApi({
      type: 'FW_NOTIFICATION',
      titleKey: 'FW_SS_FAILOVER_TITLE',
      bodyKey: 'FW_SS_FAILOVER_BODY',
      titleLocalKey: 'FW_SS_FAILOVER',
      bodyLocalKey: 'FW_SS_FAILOVER',
      bodyLocalArgs: [client.name, newClient.name],
      payload: {
        clientName: client.name,
        newClientName: newClient.name
      }
    });
  }

  moveToNextClient(tryCount = 0) {
    if(tryCount > 100) {
      return false;
    }

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

    log.info(`Select ${selectedClient.name} as primary client now.`);
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
    log.info(`${total} ss clients, ${online} clients are online, ${offline} clients [${Object.keys(this.errorClients).join(",")}] are offline, active: ${activeName}.`);
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
      if(!this.errorClients[name]) {
        list.push(client);
      }
    }

    return list;
  }
}

module.exports = new SSClientManager();
