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

// Points at the key holding the numeric mark, rather than holding it
// directly, so dnscrypt-proxy can re-read the mark while it runs. Mirrors
// the indirection unbound uses via "unbound:markkey".
const DNSCRYPT_FWMARK_KEY = "dnscrypt:markkey";

// A stamp is "sdns://" plus base64url, and nothing else ever reaches
// dnscrypt-proxy intact. Checking it here keeps one bad paste from taking the
// whole config down with it: an unparseable stamp is FATAL for the entire file,
// not just for that server.
const DNSCRYPT_STAMP_PREFIX = "sdns://";
const DNSCRYPT_STAMP_FORMAT = /^[A-Za-z0-9_-]+=*$/;

function isValidStamp(stamp) {
  if (!stamp.startsWith(DNSCRYPT_STAMP_PREFIX)) return false;
  const encoded = stamp.substring(DNSCRYPT_STAMP_PREFIX.length).replace(/=+$/, "");
  if (!DNSCRYPT_STAMP_FORMAT.test(encoded)) return false;
  // Buffer's base64 decoder skips what it cannot read, so round-trip it: only
  // a string that re-encodes to itself decoded cleanly.
  const roundTrip = Buffer.from(encoded, "base64").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return roundTrip === encoded;
}

// Quotes a user-supplied value as a TOML basic string. Names and stamps used to
// go into dnscrypt.toml as literal strings ('...'), which have no escape at all,
// so a name holding an apostrophe closed its [static.'<name>'] key early and
// dnscrypt-proxy exited FATAL on the whole file. See firecommit #10025.
function toTomlBasicString(str) {
  return JSON.stringify(str);
}

// The two things JSON escaping produces that a TOML basic string will not take:
// U+007F, which JSON.stringify passes through raw, and an unpaired surrogate,
// which it writes as \uD800 - not a valid TOML scalar. Both are rejected rather
// than stripped, because server_names is JSON.stringify'd from the very same
// name and the two spellings have to stay identical. Array.from walks by code
// point, so a properly paired surrogate arrives here as one two-char string.
function isTomlSafe(str) {
  return !Array.from(str).some((c) =>
    c === '\u007f' || (c.length === 1 && c >= '\ud800' && c <= '\udfff'));
}

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

  // Points DNSCRYPT_FWMARK_KEY at the key under which the selected VPN client
  // (or Virtual WAN Group) publishes the fwmark of its policy routing rule, so
  // dnscrypt-proxy can mark its own outgoing sockets to match, the same way any
  // other traffic gets steered into that client's routing table.
  //
  // This redis key is the whole interface: dnscrypt-proxy reads it by a name
  // fixed in the binary and resolves the mark itself on every dial (throttled),
  // exactly as unbound does with "unbound:markkey". Nothing about the VPN
  // client reaches dnscrypt.toml, so selecting a client, switching between
  // clients or turning one off never rewrites the config and never restarts
  // the proxy; a client that has published no mark yet simply leaves the
  // queries on the default route until it does.
  async setOutgoingFWMarkKey(vpnClientConfig) {
    const profileId = vpnClientConfig && vpnClientConfig.state && vpnClientConfig.profileId;
    if (typeof profileId !== 'string' || !profileId) {
      await rclient.unlinkAsync(DNSCRYPT_FWMARK_KEY);
      return;
    }
    const markKey = profileId.startsWith(Constants.ACL_VIRT_WAN_GROUP_PREFIX)
      ? VirtWanGroup.getRouteMarkKey(profileId.substring(Constants.ACL_VIRT_WAN_GROUP_PREFIX.length))
      : VPNClient.getRouteMarkKey(profileId);
    log.info("Set DoH markkey to", markKey);
    await rclient.setAsync(DNSCRYPT_FWMARK_KEY, markKey);
  }

  async prepareConfig(config = {}, reCheckConfig = false) {
    this.config = config;
    let content = await fs.readFileAsync(templatePath, { encoding: 'utf8' });
    content = content.replace("%DNSCRYPT_FALLBACK_DNS%", config.fallbackDNS || "1.1.1.1");
    content = content.replace(/%DNSCRYPT_LOCAL_PORT%/g, config.localPort || 8854);
    content = content.replace("%DNSCRYPT_IPV6%", "false");

    const settings = await this.getSettings();
    await this.setOutgoingFWMarkKey(settings.vpnClient);

    const allServers = [].concat(await this.getAllServersFromCloud(), await this.getCustomizedServers()); // get servers from cloud and customized
    // Only the servers that really make it into the toml may be named in
    // server_names, otherwise dnscrypt-proxy is pointed at a [static] table
    // that does not exist.
    const usableServers = this.filterUsableServers(allServers);
    const allServerNames = usableServers.map((x) => x.name);

    // all servers stamps will be added in the toml file
    content = content.replace("%DNSCRYPT_ALL_SERVER_LIST%", this.allServersToToml(usableServers));
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

  // Drops every server dnscrypt-proxy could choke on, so that one bad entry
  // costs that entry only. Before this, a name with an apostrophe, a name
  // repeating another server's, or a malformed stamp was a parse error on the
  // whole file: the proxy exited FATAL and systemd restarted it in a loop, DoH
  // stopped for every device in scope, and no client showed an error.
  // Cloud servers are concatenated first, so a custom server named like a
  // built-in one loses rather than shadowing it.
  filterUsableServers(servers) {
    const seen = new Set();
    return servers.filter((s) => {
      if (!s || typeof s.name !== 'string' || typeof s.stamp !== 'string' || !s.name || !s.stamp) {
        log.warn("Ignored DoH server without a usable name and stamp:", s);
        return false;
      }
      if (!isTomlSafe(s.name)) {
        log.warn("Ignored DoH server whose name cannot be written as TOML:", JSON.stringify(s.name));
        return false;
      }
      if (!isValidStamp(s.stamp)) {
        log.warn("Ignored DoH server with a malformed stamp:", s.name);
        return false;
      }
      if (seen.has(s.name)) {
        log.warn("Ignored DoH server with a duplicate name:", s.name);
        return false;
      }
      seen.add(s.name);
      return true;
    });
  }

  // Expects servers already passed through filterUsableServers.
  allServersToToml(servers) {
    /*
    servers: [
      {name: string, stamp: string}
    ]
    */
    return servers.map((s) =>
      `[static.${toTomlBasicString(s.name)}]\n  stamp = ${toTomlBasicString(s.stamp)}\n`
    ).join("\n");
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
    await rclient.unlinkAsync(serverKey, allServerKey, customizedServerkey, settingsKey, DNSCRYPT_FWMARK_KEY)
    await fileRemove(runtimePath)
  }
}

module.exports = new DNSCrypt();
