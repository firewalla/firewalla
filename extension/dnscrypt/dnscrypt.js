/*    Copyright 2019-2022 Firewalla Inc.
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

const log = require('../../net2/logger')(__filename);

const fs = require('fs');
const util = require('util');
const existsAsync = util.promisify(fs.exists);
const f = require('../../net2/Firewalla.js');

const Promise = require('bluebird');
Promise.promisifyAll(fs);

const rclient = require('../../util/redis_manager').getRedisClient();

const templatePath = `${f.getFirewallaHome()}/extension/dnscrypt/dnscrypt.template.toml`;
const runtimePath = `${f.getRuntimeInfoFolder()}/dnscrypt.toml`;

const exec = require('child-process-promise').exec;

const serverKey = "ext.dnscrypt.servers"; // selected servers list
const allServerKey = "ext.dnscrypt.allServers";
const customizedServerkey = "ext.dnscrypt.customizedServers"

const bone = require("../../lib/Bone");

class DNSCrypt {
  constructor() {
    if (instance === null) {
      instance = this;
      this.config = {};
      this._restartTask = null;
    }

    return instance;
  }

  getLocalPort() {
    return this.config.localPort || 8854;
  }

  getLocalServer() {
    return `127.0.0.1#${this.config.localPort || 8854}`;
  }

  async prepareConfig(config = {}, reCheckConfig = false) {
    this.config = config;
    let content = await fs.readFileAsync(templatePath, { encoding: 'utf8' });
    content = content.replace("%DNSCRYPT_FALLBACK_DNS%", config.fallbackDNS || "1.1.1.1");
    content = content.replace("%DNSCRYPT_LOCAL_PORT%", config.localPort || 8854);
    content = content.replace("%DNSCRYPT_LOCAL_PORT%", config.localPort || 8854);
    content = content.replace("%DNSCRYPT_IPV6%", "false");

    const allServers = [].concat(await this.getAllServersFromCloud(), await this.getCustomizedServers()); // get servers from cloud and customized
    const allServerNames = allServers.map((x) => x.name).filter(Boolean);

    // all servers stamps will be added in the toml file
    content = content.replace("%DNSCRYPT_ALL_SERVER_LIST%", this.allServersToToml(allServers));
    let serverList = await this.getServers();
    serverList = serverList.filter((n) => allServerNames.includes(n));
    content = content.replace("%DNSCRYPT_SERVER_LIST%", JSON.stringify(serverList));

    if (reCheckConfig) {
      const fileExists = await existsAsync(runtimePath);
      if (fileExists) {
        const oldContent = await fs.readFileAsync(runtimePath, { encoding: 'utf8' });
        if (oldContent == content)
          return false;
      }
    }
    await fs.writeFileAsync(runtimePath, content);
    return true;
  }

  allServersToToml(servers) {
    /*
    servers: [
      {name: string, stamp: string}
    ]
    */
    return servers.map((s) => {
      if (!s || !s.name || !s.stamp) return null;
      return `[static.'${s.name}']\n  stamp = '${s.stamp}'\n`;
    }).filter(Boolean).join("\n");
  }

  async start() {
    return exec("sudo systemctl start dnscrypt");
  }

  async restart() {
    if (this._restartTask)
      clearTimeout(this._restartTask);
    this._restartTask = setTimeout(() => {
      exec("sudo systemctl restart dnscrypt").catch((err) => {
        log.error("Failed to restart dnscrypt", err.message);
      });
    }, 3000);
  }

  async stop() {
    if (this._restartTask)
      clearTimeout(this._restartTask);
    return exec("sudo systemctl stop dnscrypt");
  }

  getDefaultServers() {
    return this.getDefaultAllServers().map(x => x.name);
  }

  async getServers() {
    const serversString = await rclient.getAsync(serverKey);
    if (!serversString) {
      return this.getDefaultServers();
    }

    try {
      const servers = JSON.parse(serversString);
      return servers;
    } catch (err) {
      log.error("Failed to parse servers, err:", err);
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

  getDefaultAllServers() {
    const result = require('./defaultServers.json');
    return result && result.servers;
  }

  async getAllServersFromCloud() {
    try {
      const serversString = await bone.hashsetAsync("doh");
      if (serversString) {
        let servers = JSON.parse(serversString);
        servers = servers.filter((server) => (server && server.name && server.stamp));
        if (servers.length > 0) {
          await this.setAllServers(servers);
          return servers;
        }
      }
    } catch (err) {
      log.error("Failed to parse servers, err:", err);
    }
    const servers = await this.getAllServers();
    return servers;
  }

  async getAllServers() {
    const serversString = await rclient.getAsync(allServerKey);
    if (serversString) {
      try {
        let servers = JSON.parse(serversString);
        servers = servers.filter((server) => (server && server.name && server.stamp));
        if (servers.length > 0)
          return servers;
      } catch (err) {
        log.error("Failed to parse servers, err:", err);
      }
    }
    return this.getDefaultAllServers();
  }

  async getAllServerNames() {
    const all = await this.getAllServers();
    return all.map((x) => x.name).filter(Boolean);
  }

  async setAllServers(servers) {
    if (servers === null) {
      return rclient.unlinkAsync(allServerKey);
    }

    return rclient.setAsync(allServerKey, JSON.stringify(servers));
  }

  async getCustomizedServers() {
    const serversString = await rclient.getAsync(customizedServerkey);
    try {
      const servers = JSON.parse(serversString) || [];
      return servers;
    } catch (err) {
      log.error("Failed to parse servers, err:", err);
      return [];
    }
  }
}

module.exports = new DNSCrypt();
