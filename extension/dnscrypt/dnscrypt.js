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

// A stamp is an "sdns:" or "sdns://" prefix plus a base64url payload.
// defaultServers.json ships both spellings - cloudflare and google use the bare
// colon, quad9 the slashes - and dnscrypt-proxy takes either, so neither may be
// turned away. It does reject base64 padding, which is dropped rather than
// treated as a bad stamp: the payload itself is fine.
const DNSCRYPT_STAMP_PREFIX = /^sdns:(\/\/)?/;
const DNSCRYPT_STAMP_PAYLOAD = /^[A-Za-z0-9_-]+$/;

// Returns the stamp in the spelling dnscrypt-proxy will take, or null when it
// is not a stamp at all. This is only a cheap pre-filter; checkConfig() has the
// final say, because whether a payload really decodes into a stamp is something
// only dnscrypt-proxy knows.
function normalizeStamp(stamp) {
  const prefix = (DNSCRYPT_STAMP_PREFIX.exec(stamp) || [])[0];
  if (!prefix) return null;
  const payload = stamp.substring(prefix.length).replace(/=+$/, "");
  if (!DNSCRYPT_STAMP_PAYLOAD.test(payload)) return null;
  // Buffer's base64 decoder skips what it cannot read, so round-trip it: only
  // a payload that re-encodes to itself decoded cleanly.
  const roundTrip = Buffer.from(payload, "base64").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (roundTrip !== payload) return null;
  return prefix + payload;
}

// dnscrypt.sh picks the binary by `uname -m`; this is the same choice.
const DNSCRYPT_ARCH_BINARY = { x64: "x86_64", arm64: "aarch64", arm: "armv7l" };

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
    const template = await fs.readFileAsync(templatePath, { encoding: 'utf8' });

    const settings = await this.getSettings();
    await this.setOutgoingFWMarkKey(settings.vpnClient);

    const allServers = [].concat(await this.getAllServersFromCloud(), await this.getCustomizedServers()); // get servers from cloud and customized
    const usableServers = this.filterUsableServers(allServers);
    const selected = await this.getServers();
    let content = this.renderConfig(template, config, usableServers, selected);

    if (reCheckConfig && await this.isRuntimeConfig(content))
      return false;

    // filterUsableServers() can only reject what is obviously not a stamp;
    // whether a payload decodes into one is dnscrypt-proxy's business, and it
    // answers by refusing the entire file. Ask it before the config goes live,
    // and if it objects, find the entries it objects to and keep the rest
    // running rather than losing every server to one bad paste.
    let verdict = await this.checkConfig(content);
    if (verdict === false) {
      const accepted = [];
      for (const s of usableServers) {
        // Only a verdict of false is grounds for dropping a server. If the
        // validator stops being runnable halfway through, keep the rest.
        if (await this.checkConfig(this.renderConfig(template, config, [s], [s.name])) === false)
          log.error("dnscrypt-proxy rejected DoH server, dropped:", s.name);
        else
          accepted.push(s);
      }
      content = this.renderConfig(template, config, accepted, selected);
      verdict = await this.checkConfig(content);
    }

    if (verdict === false) {
      // There is nothing left to drop. Whatever is running now is better than
      // a config dnscrypt-proxy has just said it will not load.
      if (await existsAsync(runtimePath)) {
        log.error("dnscrypt rejected the config with every objectionable server dropped; keeping the running one");
        return false;
      }
      log.error("dnscrypt rejected the config and there is none to keep; writing it anyway");
    }

    // Dropping entries can land on exactly what is already running, and
    // rewriting that would restart a healthy proxy on every refresh.
    if (reCheckConfig && await this.isRuntimeConfig(content))
      return false;

    await fs.writeFileAsync(runtimePath, content);
    return true;
  }

  async isRuntimeConfig(content) {
    if (!await existsAsync(runtimePath))
      return false;
    return await fs.readFileAsync(runtimePath, { encoding: 'utf8' }) === content;
  }

  renderConfig(template, config, servers, selected) {
    // Only the servers that really make it into the toml may be named in
    // server_names, otherwise dnscrypt-proxy is pointed at a [static] table
    // that does not exist.
    const available = servers.map((x) => x.name);
    const serverList = selected.filter((n) => available.includes(n));
    if (serverList.length === 0) {
      log.warn("None of selected servers found in available list, falling back to all servers");
    }
    return template
      .replace("%DNSCRYPT_FALLBACK_DNS%", config.fallbackDNS || "1.1.1.1")
      .replace(/%DNSCRYPT_LOCAL_PORT%/g, config.localPort || 8854)
      .replace("%DNSCRYPT_IPV6%", "false")
      // all servers stamps will be added in the toml file
      .replace("%DNSCRYPT_ALL_SERVER_LIST%", this.allServersToToml(servers))
      .replace("%DNSCRYPT_SERVER_LIST%", JSON.stringify(serverList));
  }

  getBinaryPath() {
    const arch = DNSCRYPT_ARCH_BINARY[process.arch] || process.arch;
    return `${f.getFirewallaHome()}/extension/dnscrypt/dnscrypt.${arch}`;
  }

  // Asks dnscrypt-proxy whether it would accept this config, without touching
  // the one it is running on. -check parses only; it binds no port.
  // true when it accepts, false when it rejects, and null when it could not be
  // asked at all: a missing or unrunnable binary says nothing about the config,
  // and reading that as a rejection would throw away every working server.
  async checkConfig(content) {
    const candidatePath = `${runtimePath}.check`;
    try {
      await fs.writeFileAsync(candidatePath, content);
      await execFile(this.getBinaryPath(), ["-config", candidatePath, "-check"]);
      return true;
    } catch (err) {
      // An exit status is a verdict on the config. Anything else - ENOENT,
      // EACCES, a signal - means the question was never put.
      if (typeof err.code !== 'number') {
        log.error("Cannot run dnscrypt-proxy -check, skipping validation:", err.message);
        return null;
      }
      // The reason is a [FATAL] line on stdout; stderr only carries notices,
      // so logging stderr alone leaves support with nothing to go on.
      const output = `${err.stdout || ""}${err.stderr || ""}`.trim().split("\n");
      log.warn("dnscrypt config rejected:",
        output.filter((l) => l.includes("[FATAL]")).pop() || output.pop() || err.message);
      return false;
    } finally {
      await fileRemove(candidatePath).catch(() => {});
    }
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
    const usable = [];
    for (const s of servers) {
      if (!s || typeof s.name !== 'string' || typeof s.stamp !== 'string' || !s.name || !s.stamp) {
        log.warn("Ignored DoH server without a usable name and stamp:", s);
        continue;
      }
      if (!isTomlSafe(s.name)) {
        log.warn("Ignored DoH server whose name cannot be written as TOML:", JSON.stringify(s.name));
        continue;
      }
      const stamp = normalizeStamp(s.stamp);
      if (!stamp) {
        log.warn("Ignored DoH server with a malformed stamp:", s.name);
        continue;
      }
      if (seen.has(s.name)) {
        log.warn("Ignored DoH server with a duplicate name:", s.name);
        continue;
      }
      seen.add(s.name);
      usable.push({ name: s.name, stamp });
    }
    return usable;
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
