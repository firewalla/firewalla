/*    Copyright 2016 Firewalla LLC 
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
const cp = require('child_process');
const Promise = require('bluebird');
const util = require('util');
const f = require('../../net2/Firewalla.js');


const instances = {};

const VPNClient = require('./VPNClient.js');

const VPNClientEnforcer = require('./VPNClientEnforcer.js');
const vpnClientEnforcer = new VPNClientEnforcer();

const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);
const execAsync = util.promisify(cp.exec);

const SERVICE_NAME = "openvpn_client";

const routing = require('../routing/routing.js');

class OpenVPNClient extends VPNClient {
  constructor(options) {
    super(options);
    const profileId = options.profileId;
    if (!profileId)
      return null;
    if (instances[profileId] == null) {
      instances[profileId] = this;
      this.profileId = profileId;

      if (f.isMain()) {
        setInterval(() => {
          this._refreshRoutes().catch((err) => {
            log.error("Failed to refresh route", err);
          });
        }, 60000); // refresh routes once every minute, in case of remote IP or interface name change due to auto reconnection
      }
    }
    return instances[profileId];
  }

  async setup() {
    const profileId = this.profileId;
    if (!profileId)
      throw "profileId is not set";
    const ovpnPath = this.getProfilePath();
    if (fs.existsSync(ovpnPath)) {
      this.ovpnPath = ovpnPath;
      await this._reviseProfile(this.ovpnPath);
    } else throw util.format("ovpn file %s is not found", ovpnPath);
  }

  getProfilePath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".ovpn";
    return path;
  }

  getPasswordPath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".password";
    return path;
  }

  getUserPassPath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".userpass";
    return path;
  }

  _getPushOptionsPath() {
    return `${f.getHiddenFolder()}/run/ovpn_profile/${this.profileId}.push_options`;
  }

  _getStatusLogPath() {
    return `/var/log/openvpn_client-status-${this.profileId}.log`;
  }

  async _parseProfile(ovpnPath) {
    if (fs.existsSync(ovpnPath)) {
      const content = await readFileAsync(ovpnPath, 'utf8');
      const lines = content.split("\n");
      this._intfType = "tun";
      for (let line of lines) {
        const options = line.split(/\s+/);
        const option = options[0];
        switch (option) {
          case "dev":
          case "dev-type":
            const value = options[1];
            if (value.startsWith("tun"))
              this._intfType = "tun";
            if (value.startsWith("tap"))
              this._intfType = "tap";
            break;
          default:
        }
      }
    } else {
      throw util.format("ovpn file %s is not found", ovpnPath);
    }
  }

  async _reviseProfile(ovpnPath) {
    const cmd = "openvpn --version | head -n 1 | awk '{print $2}'";
    const result = await execAsync(cmd);
    const version = result.stdout;
    let content = await readFileAsync(ovpnPath, 'utf8');
    let revisedContent = content;
    const intf = this.getInterfaceName();
    await this._parseProfile(ovpnPath);
    // used customized interface name
    revisedContent = revisedContent.replace(/^dev\s+.*$/gm, `dev ${intf}`);
    // specify interface type with 'dev-type'
    if (this._intfType === "tun") {
      if (!revisedContent.match(/^dev-type\s+tun\s*/gm)) {
        revisedContent = "dev-type tun\n" + revisedContent;
      }
    } else {
      if (!revisedContent.match(/^dev-type\s+tap\s*/gm)) {
        revisedContent = "dev-type tap\n" + revisedContent;
      }
    }
    // add private key password file to profile if present
    if (fs.existsSync(this.getPasswordPath())) {
      if (!revisedContent.match(/^askpass.*$/gm)) {
        revisedContent = `askpass ${this.getPasswordPath()}\n${revisedContent}`;
      } else {
        revisedContent = revisedContent.replace(/^askpass.*$/gm, `askpass ${this.getPasswordPath()}`);
      }
    }
    // add user/pass file to profile if present
    if (fs.existsSync(this.getUserPassPath())) {
      if (!revisedContent.match(/^auth-user-pass.*$/gm)) {
        revisedContent = `auth-user-pass ${this.getUserPassPath()}\n${revisedContent}`;
      } else {
        revisedContent = revisedContent.replace(/^auth-user-pass.*$/gm, `auth-user-pass ${this.getUserPassPath()}`);
      }
    }

    if (version.startsWith("2.3.")) {
      const lines = content.split("\n");
      lines.forEach((line) => {
        const options = line.split(/\s+/);
        const option = options[0];
        switch (option) {
          case "compress":
            // OpenVPN 2.3.x does not support 'compress' option
            if (options.length > 1) {
              const algorithm = options[1];
              if (algorithm !== "lzo") {
                throw util.format("Unsupported compress algorithm for OpenVPN 2.3: %s", algorithm);
              } else {
                revisedContent = revisedContent.replace(/compress\s+lzo/g, "comp-lzo");
              }
            } else {
              // turn off compression, set 'comp-lzo' to no
              revisedContent = revisedContent.replace(/compress/g, "comp-lzo no");
            }
            break;
          default:
        }
      })
    }
    if (version.startsWith("2.4.")) {
      // 'comp-lzo' is deprecated in 2.4.x
      revisedContent = revisedContent.replace(/comp\-lzo/g, "compress lzo");
    }
    await writeFileAsync(ovpnPath, revisedContent, 'utf8');
  }

  async _refreshRoutes() {
    // no need to refresh routes if vpn client is not started
    if (!this._started) {
      return;
    }
    const newRemoteIP = await this.getRemoteIP();
    const intf = this.getInterfaceName();
    if (newRemoteIP === null) {
      // vpn client is down unexpectedly
      log.error("VPN client " + this.profileId + " remote IP is missing.");
      this.emit('link_broken');
      return;
    }
    // no need to refresh if remote ip and interface are not changed
    if (newRemoteIP !== this._remoteIP) {
      log.info(`Refresh OpenVPN client routes for ${this.profileId}: ${newRemoteIP}, ${intf}`);
      await vpnClientEnforcer.enforceVPNClientRoutes(newRemoteIP, intf);
      this._remoteIP = newRemoteIP;
    }
  }

  async start() {
    if (!this.profileId) {
      throw "OpenVPN client is not setup properly. Profile id is missing."
    }
    let cmd = util.format("sudo systemctl restart \"%s@%s\"", SERVICE_NAME, this.profileId);
    await execAsync(cmd);
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const establishmentTask = setInterval(() => {
        (async () => {
          const remoteIP = await this.getRemoteIP();
          if (remoteIP !== null && remoteIP !== "") {
            this._remoteIP = remoteIP;
            try {
              // remove two routes from main table which is inserted by OpenVPN client automatically,
              // otherwise tunnel will be enabled globally
              const intf = this.getInterfaceName();
              await routing.removeRouteFromTable("0.0.0.0/1", remoteIP, intf, "main");
              await routing.removeRouteFromTable("128.0.0.0/1", remoteIP, intf, "main");
            } catch (err) {
              // these routes may not exist depending on server config
              log.error("Failed to remove default vpn client route", err);
            }
            clearInterval(establishmentTask);
            const intf = this.getInterfaceName();
            // add vpn client specific routes
            await vpnClientEnforcer.enforceVPNClientRoutes(remoteIP, intf);
            await this._processPushOptions();
            if (this._dnsServers && this._dnsServers.length > 0) {
              await vpnClientEnforcer.enforceDNSRedirect(intf, this._dnsServers);
            }
            this._started = true;
            resolve(true);
          } else {
            const now = Date.now();
            if (now - startTime > 20000) {
              log.error("Failed to establish tunnel for OpenVPN client, stop it...");
              clearInterval(establishmentTask);
              resolve(false);
            }
          }
        })().catch((err) => {
          log.error("Failed to start vpn client", err);
          clearInterval(establishmentTask);
          resolve(false);
        });
      }, 2000);
    });
  }

  async _processPushOptions() {
    const pushOptionsFile = this._getPushOptionsPath();
    this._dnsServers = [];
    if (fs.existsSync(pushOptionsFile)) {
      const content = await readFileAsync(pushOptionsFile, "utf8");
      if (!content)
        return;
      const dnsServers = [];
      for (let line of content.split("\n")) {
        const options = line.split(/\s+/);
        switch (options[0]) {
          case "dhcp-option":
            if (options[1] === "DNS") {
              dnsServers.push(options[2]);
            }
            break;
          default:
        }
      }
      this._dnsServers = dnsServers;
    }
  }

  async stop() {
    // flush routes before stop vpn client to ensure smooth switch of traffic routing
    const intf = this.getInterfaceName();
    this._started = false;
    await vpnClientEnforcer.flushVPNClientRoutes(intf);
    await this._processPushOptions();
    if (this._dnsServers && this._dnsServers.length > 0) {
      await vpnClientEnforcer.unenforceDNSRedirect(intf, this._dnsServers);
    }
    let cmd = util.format("sudo systemctl stop \"%s@%s\"", SERVICE_NAME, this.profileId);
    await execAsync(cmd);
    cmd = util.format("sudo systemctl disable \"%s@%s\"", SERVICE_NAME, this.profileId);
    await execAsync(cmd);
  }

  async status() {
    const cmd = util.format("systemctl is-active \"%s@%s\"", SERVICE_NAME, this.profileId);
    try {
      await execAsync(cmd);
      return true;
    } catch (err) {
      return false;
    }
  }

  async getStatistics() {
    const status = await this.status();
    if (!status) {
      return {};
    }
    try {
      const stats = {};
      const statusLogPath = this._getStatusLogPath();
      // add read permission in case it is owned by root
      const cmd = util.format("sudo chmod +r %s", statusLogPath);
      await execAsync(cmd);
      const content = await readFileAsync(statusLogPath, "utf8");
      const lines = content.split("\n");
      for (let line of lines) {
        const options = line.split(",");
        const key = options[0];
        switch (key) {
          case "TUN/TAP read bytes":
            // this corresponds to number of original bytes sent to vpn channel. NOT a typo! Read actually corresponds to bytes sent
            stats['bytesOut'] = Number(options[1]);
            break;
          case "TUN/TAP write bytes":
            // this corresponds to number of original bytes received from vpn channel. NOT a type! Write actually corresponds to bytes read
            stats['bytesIn'] = Number(options[1]);
            break;
          case "TCP/UDP read bytes":
            // this corresponds to number of bytes received from VPN server through underlying transport layer
            stats['transportBytesIn'] = Number(options[1]);
            break;
          case "TCP/UDP write bytes":
            // this corresponds to number of bytes sent to VPN server through underlying transport layer
            stats['transportBytesOut'] = Number(options[1]);
            break;
          default:

        }
      }
      return stats;
    } catch (err) {
      log.error("Failed to parse OpenVPN client status file for " + this.profileId, err);
      return {};
    }
  }

  async getRemoteIP() {
    const intf = this.getInterfaceName();
    const cmd = util.format("ifconfig | grep '^%s' -A 2 | grep 'P-t-P' | awk '{print $2,$3}'", intf);
    const result = await execAsync(cmd);
    const lines = result.stdout.split('\n');
    for (let i in lines) {
      const line = lines[i];
      if (line.length == 0)
        continue;
      const addrs = line.split(" ");
      const local = addrs[0].split(':')[1];
      const peer = addrs[1].split(':')[1];
      if (local.split('.')[3] !== "1") {
        // this is an address belonging to OpenVPN client
        return peer;
      }
    }
    return null;
  }

  getInterfaceName() {
    if (!this.profileId) {
      throw "profile id is not defined"
    }
    return `vpn_${this.profileId}`
  }
}

module.exports = OpenVPNClient;