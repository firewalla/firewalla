/*    Copyright 2019-2023 Firewalla Inc.
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

//JSDoc for typedefs
/** @typedef {{ name: string, stamp: string }} DNSCryptServerList */
/** @typedef {DNSCryptServerList & { url: string }} DNSCryptServerListWithUrl */
/** @typedef {ReturnType<typeof exec>} ReTyExec */

//Core Node.js APIs
const fs = require('fs');
const { exec } = require('child-process-promise');
const util = require('util');
//External dependencies
const PromiseBB = require('bluebird');
//Local files
const log = require('../../net2/logger')(__filename);
const f = require('../../net2/Firewalla.js');
const bone = require("../../lib/Bone");
const rclient = require('../../util/redis_manager').getRedisClient();
const { fileRemove } = require('../../util/util.js')

//apply promisify to fs
PromiseBB.promisifyAll(fs);

//file constant variables
const existsAsync = util.promisify(fs.exists);
/** @example "[\"cloudflare\"]" */
const serverKey = "ext.dnscrypt.servers"; // selected servers list
/** @example "[{\"name\":\"cloudflare\",\"stamp\":\"sdns://cf\"}]" */
const allServerKey = "ext.dnscrypt.allServers";
/** @example "[{\"name\":\"my dns\",\"stamp\":\"sdns://mdns\",\"url\":\"https://my-dns.com/firewalla\"}]" */
const customizedServerkey = "ext.dnscrypt.customizedServers"
const configTemplatePath = `${f.getFirewallaHome()}/extension/dnscrypt/dnscrypt.template.toml`;
const configRuntimePath = `${f.getRuntimeInfoFolder()}/dnscrypt.toml`;
const defaultFallback = "1.1.1.1";
const defaultLocalPort = 8854;
let instance = null;

class DNSCrypt {
  constructor() {
    if (instance === null) {
      instance = this;
      this.config = {};
      this._restartTask = null;
    }

    return instance;
  }

  /** 
   * Returns the port that dnscrypt is listening on.
   * If it is not set, it will return the default port.
   * @example 8854
   * @returns {number} 
   */
  getLocalPort() {
    return this.config.localPort || defaultLocalPort;
  }

  /** 
   * Returns the local server address that dnscrypt is listening on.
   * @example '127.0.0.1#8854'
   * @returns {string} 
   */
  getLocalServer() {
    return `127.0.0.1#${this.config.localPort || defaultLocalPort}`;
  }

  async prepareConfig(config = {}, reCheckConfig = false) {
    this.config = config;
    let content = await fs.readFileAsync(configTemplatePath, { encoding: 'utf8' });
    content = content.replace("%DNSCRYPT_FALLBACK_DNS%", config.fallbackDNS || defaultFallback);
    content = content.replace("%DNSCRYPT_LOCAL_PORT%", config.localPort || defaultLocalPort);
    content = content.replace("%DNSCRYPT_LOCAL_PORT%", config.localPort || defaultLocalPort);
    content = content.replace("%DNSCRYPT_IPV6%", "false");

    const allServers = [].concat(await this.getAllServersFromCloud(), await this.getCustomizedServers()); // get servers from cloud and customized
    const allServerNames = allServers.map((x) => x.name).filter(Boolean);

    // all servers stamps will be added in the toml file
    content = content.replace("%DNSCRYPT_ALL_SERVER_LIST%", this.allServersToToml(allServers));
    let serverList = await this.getServers();
    serverList = serverList.filter((n) => allServerNames.includes(n));
    content = content.replace("%DNSCRYPT_SERVER_LIST%", JSON.stringify(serverList));

    if (reCheckConfig) {
      const fileExists = await existsAsync(configRuntimePath);

      if (fileExists) {
        const oldContent = await fs.readFileAsync(configRuntimePath, { encoding: 'utf8' });

        if (oldContent == content) {
          return false;
        }
      }
    }
    await fs.writeFileAsync(configRuntimePath, content);
    return true;
  }

  /**
   * Convert servers to toml format
   * @param {DNSCryptServerList[]} servers
   */
  allServersToToml(servers) {
    return servers.map((s) => {
      if (!s || !s.name || !s.stamp) {
        return null;
      }
      return `[static.'${s.name}']\n  stamp = '${s.stamp}'\n`;
    }).filter(Boolean).join("\n");
  }

  /**
   * Check if the dnscrypt service is running by executing a bash command.
   */
  async start() {
    return await exec("sudo systemctl start dnscrypt");
  }

  /**
   * Restart the dnscrypt service.
   * If the task has passed the restart time, it be cleared.
   */
  async restart() {
    if (this._restartTask) {
      clearTimeout(this._restartTask);
    }

    this._restartTask = setTimeout(() => {
      exec("sudo systemctl restart dnscrypt").catch((err) => {
        log.error("Failed to restart dnscrypt", err.message);
      });
    }, 3000);
  }

  /**
   * Stop the dnscrypt service.
   * If the task has passed the restart time, it be cleared.
   */
  async stop() {
    if (this._restartTask) {
      clearTimeout(this._restartTask);
    }
    return await exec("sudo systemctl stop dnscrypt");
  }

  /**
   * Get the names off of the default servers in the json
   * @returns {string[]}
   * @example ['cloudflare', 'google', 'quad9']
   */
  getDefaultServers() {
    return this.getDefaultAllServers().map(x => x.name);
  }

  /**
   * Get the servers from redis.
   * If redis doesn't have it, it will return the default servers.
   * @returns {Promise<string[]>}
   * @example ['cloudflare', 'google', 'quad9']
   * @see {@link getDefaultServers} if redis doesn't have it
   */
  async getServers() {
    try {
      /** @type {string|null|undefined} */
      const serversString = await rclient.getAsync(serverKey);

      if (!serversString) {
        throw new Error('No servers found in db.');
      }

      return JSON.parse(serversString);
    } catch (err) {
      log.error("Failed to parse servers in getServers, err:", err);
      return this.getDefaultServers();
    }
  }

  async setServers(servers, customized) {
    const key = customized ? customizedServerkey : serverKey;

    if (servers === null) {
      return rclient.unlinkAsync(key);
    }

    return rclient.setAsync(key, JSON.stringify(servers));
  }

  /**
   * Get all servers from defaultServers.json
   * @returns {DNSCryptServerList[]}
   * @example [{ name: 'cloudflare', stamp: 'sdns://cf' }]
   */
  getDefaultAllServers() {
    const result = require('./defaultServers.json');
    return result && result.servers;
  }

  /**
   * Call the API to get servers.
   * @returns {Promise<DNSCryptServerList[]>}
   * @see {@link getAllServers} if api fails
   * @example [{ name: 'cloudflare', stamp: 'sdns://cf' }]
   */
  async getAllServersFromCloud() {
    try {
      /** @type {string|null|undefined} */
      const serversString = await bone.hashsetAsync("doh");

      if (serversString) {
        /** @type {DNSCryptServerList[]} */
        let servers = JSON.parse(serversString);
        servers = servers.filter((server) => (server && server.name && server.stamp));

        if (servers.length > 0) {
          await this.setAllServers(servers);
          return servers;
        }
      }
    } catch (err) {
      log.error("Failed to parse servers in getAllServersFromCloud, err:", err);
    }
    const servers = await this.getAllServers();
    return servers;
  }

  /**
   * Get all servers from redis.
   * @returns {Promise<DNSCryptServerList[]>}
   * @see {@link getDefaultAllServers} if redis doesn't have it
   * @example [{ name: 'cloudflare', stamp: 'sdns://cf' }]
   */
  async getAllServers() {
    /** @type {string|null|undefined} */
    const serversString = await rclient.getAsync(allServerKey);

    if (serversString) {
      try {
        /** @type {DNSCryptServerList[]} */
        let servers = JSON.parse(serversString);
        servers = servers.filter((server) => (server && server.name && server.stamp));

        if (servers.length > 0) {
          return servers;
        }
      } catch (err) {
        log.error("Failed to parse servers in getAllServers, err:", err);
      }
    }
    return this.getDefaultAllServers();
  }

  /**
   * Get all server names from redis
   * @returns {Promise<string[]>}
   * @example ['cloudflare', 'google', 'quad9']
   */
  async getAllServerNames() {
    const all = await this.getAllServers();
    return all.map((x) => x.name).filter(Boolean);
  }

  /**
   * Set all servers to redis.
   * If the parameter is null, it will remove the key in the db.
   * @param {DNSCryptServerList[]} servers 
   */
  async setAllServers(servers) {
    if (servers === null) {
      return rclient.unlinkAsync(allServerKey);
    }

    return rclient.setAsync(allServerKey, JSON.stringify(servers));
  }

  /**
   * Get customized servers from redis
   * @returns {Promise<DNSCryptServerListWithUrl[]>}
   * @example [{ name: 'my dns', stamp: 'sdns://mdns', url: 'https://my-dns.com/firewalla' }]
   */
  async getCustomizedServers() {
    try {
      /** @type {string} */
      const serversString = await rclient.getAsync(customizedServerkey);
      /** @type {DNSCryptServerListWithUrl[]} */
      const servers = JSON.parse(serversString) || [];
      return servers;
    } catch (err) {
      log.error("Failed to parse servers in getCustomizedServers, err:", err);
      return [];
    }
  }

  /**
   * Stop the dnscrypt service and remove all servers
   * @returns {Promise<void>}
   */
  async resetSettings() {
    await this.stop()
    await rclient.unlinkAsync(serverKey, allServerKey, customizedServerkey)
    await fileRemove(configRuntimePath)
  }
}

module.exports = new DNSCrypt();
