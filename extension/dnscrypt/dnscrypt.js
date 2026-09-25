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

let instance = null;

const log = require('../../net2/logger')(__filename);

const fs = require('fs');
const util = require('util');
const existsAsync = util.promisify(fs.exists);
const f = require('../../net2/Firewalla.js');
const { fileRemove } = require('../../util/util.js')

const Promise = require('bluebird');
Promise.promisifyAll(fs);

const rclient = require('../../util/redis_manager').getRedisClient();

const templatePath = `${f.getFirewallaHome()}/extension/dnscrypt/dnscrypt.template.toml`;
const runtimePath = `${f.getRuntimeInfoFolder()}/dnscrypt.toml`;

const { execFile } = require('child-process-promise');

const serverKey = "ext.dnscrypt.servers"; // selected servers list
const allServerKey = "ext.dnscrypt.allServers";
const customizedServerkey = "ext.dnscrypt.customizedServers"
const settingsKey = "ext.dnscrypt.settings";

const DOH_VPN_MARK_UNAVAILABLE = "DOH_VPN_MARK_UNAVAILABLE";

const bone = require("../../lib/Bone");
const Constants = require('../../net2/Constants.js');
const VPNClient = require('../vpnclient/VPNClient');
const VirtWanGroup = require('../../net2/VirtWanGroup.js');

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

  get DOH_VPN_MARK_UNAVAILABLE() {
    return DOH_VPN_MARK_UNAVAILABLE;
  }

  // Resolves the vpnClient setting to the numeric fwmark already used by
  // that VPN client's (or Virtual WAN Group's) policy routing rule, so
  // dnscrypt-proxy can mark its own outgoing sockets to match, the same way
  // any other traffic gets steered into that client's routing table.
  // Throws when a client is selected but its mark is not resolvable (e.g. it
  // has never been started): writing a config without the mark would send
  // DoH out over the plain WAN, which is what the setting exists to prevent.
  async getOutgoingFWMark(vpnClientConfig) {
    if (!vpnClientConfig || !vpnClientConfig.state || !vpnClientConfig.profileId)
      return null;
    const profileId = vpnClientConfig.profileId;
    const markKey = profileId.startsWith(Constants.ACL_VIRT_WAN_GROUP_PREFIX)
      ? VirtWanGroup.getRouteMarkKey(profileId.substring(Constants.ACL_VIRT_WAN_GROUP_PREFIX.length))
      : VPNClient.getRouteMarkKey(profileId);
    const mark = Number(await rclient.getAsync(markKey));
    if (!mark) {
      const err = new Error(`No route mark found for DoH vpnClient ${profileId}`);
      err.code = DOH_VPN_MARK_UNAVAILABLE;
      throw err;
    }
    return mark;
  }

  async prepareConfig(config = {}, reCheckConfig = false) {
    this.config = config;
    let content = await fs.readFileAsync(templatePath, { encoding: 'utf8' });
    content = content.replace("%DNSCRYPT_FALLBACK_DNS%", config.fallbackDNS || "1.1.1.1");
    content = content.replace(/%DNSCRYPT_LOCAL_PORT%/g, config.localPort || 8854);
    content = content.replace("%DNSCRYPT_IPV6%", "false");

    const settings = await this.getSettings();
    const fwmark = await this.getOutgoingFWMark(settings.vpnClient);
    content = content.replace("%DNSCRYPT_FWMARK%", fwmark ? `fwmark = ${fwmark}` : '');

    const allServers = [].concat(await this.getAllServersFromCloud(), await this.getCustomizedServers()); // get servers from cloud and customized
    const allServerNames = allServers.map((x) => x.name).filter(Boolean);

    // all servers stamps will be added in the toml file
    content = content.replace("%DNSCRYPT_ALL_SERVER_LIST%", this.allServersToToml(allServers));
    let serverList = await this.getServers();
    serverList = serverList.filter((n) => allServerNames.includes(n));
    if (serverList.length === 0) {
      log.warn("None of selected servers found in available list, falling back to all servers");
    }
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
    return execFile("sudo", ["systemctl", "start", "dnscrypt"]);
  }

  restart() {
    if (this._restartTask)
      clearTimeout(this._restartTask);
    this._restartTask = setTimeout(() => {
      execFile("sudo", ["systemctl", "restart", "dnscrypt"]).catch((err) => {
        log.error("Failed to restart dnscrypt", err.message);
      });
    }, 3000);
  }

  async stop() {
    if (this._restartTask)
      clearTimeout(this._restartTask);
    return execFile("sudo", ["systemctl", "stop", "dnscrypt"]);
  }

  getDefaultServers() {
    return this.getDefaultAllServers().map(x => x.name);
  }

  getDefaultSettings() {
    return {
      killSwitch: true
    };
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

  async getSettings() {
    const settingsString = await rclient.getAsync(settingsKey);
    if (!settingsString)
      return this.getDefaultSettings();
    try {
      return Object.assign({}, this.getDefaultSettings(), JSON.parse(settingsString) || {});
    } catch (err) {
      log.error("Failed to parse dnscrypt settings, err:", err);
      return this.getDefaultSettings();
    }
  }

  async updateSettings(settings) {
    const currentSettings = await this.getSettings();
    const nextSettings = Object.assign({}, currentSettings, settings || {});
    return rclient.setAsync(settingsKey, JSON.stringify(nextSettings));
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

  async resetSettings() {
    await this.stop()
    await rclient.unlinkAsync(serverKey, allServerKey, customizedServerkey, settingsKey)
    await fileRemove(runtimePath)
  }
}

module.exports = new DNSCrypt();
