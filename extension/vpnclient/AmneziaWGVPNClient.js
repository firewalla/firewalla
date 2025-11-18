/*    Copyright 2016 - 2025
 Firewalla Inc 
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

const log = require('../../net2/logger.js')(__filename);
const fs = require('fs');
const f = require('../../net2/Firewalla.js');
const WGVPNClient = require('./WGVPNClient.js');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const {Address4, Address6} = require('ip-address');
const _ = require('lodash');
const PlatformLoader = require('../../platform/PlatformLoader.js');
const platform = PlatformLoader.getPlatform()

class AmneziaWGVPNClient extends WGVPNClient {
  constructor(options) {
    super(options);
    this.wgCmd = `${platform.getPlatformFilesPath()}/awg`;
  }

  static convertPlainTextToJson(content) {
    let addresses = [];
    let dns = []
    const peers = [];
    const config = {};
    const lines = content.split("\n");
    let peer = null;
    let currentSection = null;
    for (const line of lines) {
      if (line === "[Interface]" || line === "[Peer]") {
        if (line === "[Peer]") {
          // use 20 seconds as default persistentKeepalive value
          peer = {persistentKeepalive: 20};
          peers.push(peer);
        }
        currentSection = line;
        continue;
      }
      if (!line.includes('='))
        continue;
      const key = line.substring(0, line.indexOf('=')).trim();
      const value = line.substring(line.indexOf('=') + 1).trim();
      switch (currentSection) {
        case "[Interface]": {
          if (key === "Address")
            addresses = addresses.concat(value.split(',').map(v => v.trim()));
          if (key === "PrivateKey")
            config.privateKey = value;
          if (key === "DNS")
            dns = dns.concat(value.split(',').map(v => v.trim()));
          if (key === "MTU")
            config.mtu = value;
          if (key === "Jc")
            config.jc = value;
          if (key === "Jmin")
            config.jmin = value;
          if (key === "Jmax")
            config.jmax = value;
          if (key === "S1")
            config.s1 = value;
          if (key === "S2")
            config.s2 = value;
          if (key === "H1")
            config.h1 = value;
          if (key === "H2")
            config.h2 = value;
          if (key === "H3")
            config.h3 = value;
          if (key === "H4")
            config.h4 = value;
          break;
        }
        case "[Peer]": {
          if (key === "PublicKey")
            peer.publicKey = value;
          if (key === "Endpoint")
            peer.endpoint = value;
          if (key === "AllowedIPs")
            peer.allowedIPs = value.split(',').map(v => v.trim());
          if (key === "PresharedKey")
            peer.presharedKey = value;
          if (key === "PersistentKeepalive")
            peer.persistentKeepalive = value;
          break;
        }
        default:
      }
    }
    config.addresses = addresses;
    config.dns = dns;
    config.peers = peers;
    return config;
  }


  static getProtocol() {
    return "amneziawg";
  }

  static getKeyNameForInit() {
    return "awgvpnClientProfiles";
  }

  _getConfigPath() {
    return `${f.getHiddenFolder()}/run/awg_profile/${this.profileId}.conf`;
  }


  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/awg_profile`;
  }

  // return at most last N_SESS sessions
  async getLatestSessionLog() {
    const N_SESS = 3; // retrieve last 3 sessions

    // TODO: make VPNClient.logDir configurable, NEVER defined here
    const logPath = `${this.logDir || "/var/log/awg"}/vpn_${this.profileId}.log`;
    const content = await exec(`sudo tail -n 100 ${logPath}`).then(result => result.stdout.trim()).catch((err) => null);
    if (content) {
      return AmneziaWGVPNClient._getLastNSession(content, "Interface created", N_SESS);
    }
    return null;
  }

  static _getLastNSession(content, pattern, count) {
    const lines = content.split('\n');
    let beginIdx = -1;
    let hit = 0;
    for (let i=lines.length-1; i >= 0 && hit < count;  i--){
      if (lines[i].includes(pattern)) {
        hit++
        beginIdx = i;
      }
    }
    if (beginIdx >= 0) {
      return lines.slice(beginIdx).join("\n");
    }

    // no pattern found, return last 30 lines of log
    // maybe pattern line failed to sync at startup.
    return lines.slice(Math.max(lines.length-30, 0)).join("\n");
  }

  _addObfuscationOptions(entries, config) {
    const obfuscationKeys = [
      'jc', 'jmin', 'jmax',
      's1', 's2',
      'h1', 'h2', 'h3', 'h4'
    ];
    for (const key of obfuscationKeys) {
      if (config[key]) {
        entries.push(`${key.toUpperCase()} = ${config[key]}`);
      }
    }
  }



}


module.exports = AmneziaWGVPNClient;