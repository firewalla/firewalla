/*    Copyright 2019-2020 Firewalla INC
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

const serverKey = "ext.dnscrypt.servers";
const allServerKey = "ext.dnscrypt.allServers";

const bone = require("../../lib/Bone");
const { DNSStamp } = require("../../vendor_lib/DNSStamp.js");
const _ = require('lodash');

class DNSCrypt {
  constructor() {
    if(instance === null) {
      instance = this;
      this.config = {};
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
    let content = await fs.readFileAsync(templatePath, {encoding: 'utf8'});
    content = content.replace("%DNSCRYPT_FALLBACK_DNS%", config.fallbackDNS || "1.1.1.1");
    content = content.replace("%DNSCRYPT_LOCAL_PORT%", config.localPort || 8854);
    content = content.replace("%DNSCRYPT_LOCAL_PORT%", config.localPort || 8854);
    content = content.replace("%DNSCRYPT_IPV6%", "false");

    const allServers = await this.getAllServers(); // get servers from cloud
    let serverList = await this.getServers();
    const allServerNames = allServers.map((x) => x.name).filter(Boolean);
    content = content.replace("%DNSCRYPT_ALL_SERVER_LIST%", this.allServersToToml(allServers, serverList));

    serverList = serverList.map((server) => {
      if (allServerNames.includes(server)) { return server }
      if (allServerNames.includes(server.name)) { return `${server.name}_${server.id}` }
    }).filter(Boolean)
    content = content.replace("%DNSCRYPT_SERVER_LIST%", JSON.stringify(serverList));

    if (reCheckConfig) {
      const fileExists = await existsAsync(runtimePath);
      if (fileExists) {
        const oldContent = await fs.readFileAsync(runtimePath, {encoding: 'utf8'});
        if (oldContent == content)
          return false;
      }
    }
    await fs.writeFileAsync(runtimePath, content);
    return true;
  }

  allServersToToml(servers, selectedServers) {
    /*
    servers from cloud: [
      {name: string, stamp: string},
      {
        name:'nextdns',
        hostName:'dns.nextdns.io',
        ip:'45.90.28.0'
      }
    ]
    selectedServers: [
      string | object{name:'nextdns',id:'xyz'}
    ]
    */
    return servers.map((s) => {
      if (!s) return null;
      let stamp = s.stamp;
      let name = s.name;
      if (!stamp) {
        const server = _.find(selectedServers, (item) => {
          return item && item.name == s.name;
        });
        if (!server) return null;
        switch (s.name) {
          case 'nextdns':
            if (s.ip && s.hostName) {
              stamp = new DNSStamp.DOH(s.ip, {
                "hostName": s.hostName,
                "path": `/${server.id}`,
                "props": new DNSStamp.Properties({
                  nofilter: server.nofilter === undefined ? false : server.nofilter,
                  nolog: server.nolog === undefined ? false : server.nolog,
                  dnssec: server.nolog === undefined ? true : server.nolog,
                }),
              }).toString();
              name = `${name}_${server.id}`
            }
        }
      }
      if (!stamp) return null;
      return `[static.'${name}']\n  stamp = '${stamp}'\n`;
    }).filter(Boolean).join("\n");
  }

  async start() {
    return exec("sudo systemctl start dnscrypt");
  }

  async restart() {
    return exec("sudo systemctl restart dnscrypt");
  }

  async stop() {
    return exec("sudo systemctl stop dnscrypt");
  }

  getDefaultServers() {
    return this.getDefaultAllServers().map(x => x.name);
  }

  async getServers() {
    const serversString = await rclient.getAsync(serverKey);
    if(!serversString) {
      return this.getDefaultServers();
    }

    try {
      const servers = JSON.parse(serversString);
      return servers;
    } catch(err) {
      log.error("Failed to parse servers, err:", err);
      return this.getDefaultServers();
    }
  }

  async setServers(servers) {
    if(servers === null) {
      return rclient.delAsync(serverKey);
    }

    return rclient.setAsync(serverKey, JSON.stringify(servers));
  }

  getDefaultAllServers() {
    const result = require('./defaultServers.json');
    return result && result.servers;
  }

  async getAllServers() {
    //const serversString = await rclient.getAsync(allServerKey);
    const serversString = await bone.hashsetAsync("doh");
    if (serversString) {
      try {
        let servers = JSON.parse(serversString);
        servers = servers.filter((server) => (server && server.name && server.stamp));
        if (servers.length > 0)
          return servers;
      } catch(err) {
        log.error("Failed to parse servers, err:", err);
      }
    }
    return this.getDefaultAllServers();
  }

  async getAllServerNames() {
    const all = await this.getAllServers();
    return all.map((x) => x.name).filter(Boolean);
  }

  // ['cloudflare',{name:'nextdns',id:'xyz'}]
  async setAllServers(servers) {
    if(servers === null) {
      return rclient.delAsync(serverKey);
    }

    return rclient.setAsync(serverKey, JSON.stringify(servers));
  }
}

module.exports = new DNSCrypt();