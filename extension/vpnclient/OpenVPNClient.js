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
const sysManager = require('../../net2/SysManager');
const ipTool = require('ip');
const iptables = require('../../net2/Iptables.js');
const sclient = require('../../util/redis_manager.js').getSubscriptionClient();
const Message = require('../../net2/Message.js');

const instances = {};

const VPNClient = require('./VPNClient.js');

const vpnClientEnforcer = require('./VPNClientEnforcer.js');

const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);
const accessAsync = util.promisify(fs.access);
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
          this._checkConnectivity().catch((err) => {
            log.error("Failed to check connectivity", err);
          });
        }, 60000); // refresh routes once every minute, in case of remote IP or interface name change due to auto reconnection

        sclient.on("message", (channel, message) => {
          if (channel === Message.MSG_OVPN_CLIENT_ROUTE_UP && message === this.profileId) {
            log.info(`VPN client ${this.profileId} route is up, attempt refreshing routes ...`);
            this._refreshRoutes().catch((err) => {
              log.error("Failed to refresh routes", err);
            });
          }
        });
        sclient.subscribe(Message.MSG_OVPN_CLIENT_ROUTE_UP);
      }
    }
    return instances[profileId];
  }

  async setup() {
    const profileId = this.profileId;
    if (!profileId)
      throw "profileId is not set";
    const ovpnPath = this.getProfilePath();
    if (await accessAsync(ovpnPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      this.ovpnPath = ovpnPath;
      await this._reviseProfile(this.ovpnPath);
    } else throw util.format("ovpn file %s is not found", ovpnPath);
    const settings = await this.loadSettings();
    // check settings
    if (settings.serverSubnets && Array.isArray(settings.serverSubnets)) {
      for (let serverSubnet of settings.serverSubnets) {
        const ipSubnets = serverSubnet.split('/');
        if (ipSubnets.length != 2)
          throw `${serverSubnet} is not a valid CIDR subnet`;
        const ipAddr = ipSubnets[0];
        const maskLength = ipSubnets[1];
        if (!ipTool.isV4Format(ipAddr))
          throw `${serverSubnet} is not a valid CIDR subnet`;
        if (isNaN(maskLength) || !Number.isInteger(Number(maskLength)) || Number(maskLength) > 32 || Number(maskLength) < 0)
          throw `${serverSubnet} is not a valid CIDR subnet`;
        const serverSubnetCidr = ipTool.cidrSubnet(serverSubnet);
        for (const iface of sysManager.getLogicInterfaces()) {
          const mySubnetCidr = iface.subnet && ipTool.cidrSubnet(iface.subnet);
          if (!mySubnetCidr)
            continue;
          if (mySubnetCidr.contains(serverSubnetCidr.firstAddress) || serverSubnetCidr.contains(mySubnetCidr.firstAddress))
            throw `${serverSubnet} conflicts with subnet of ${iface.name} ${iface.subnet}`;
        }
      }
    }
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

  getSettingsPath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".settings";
    return path;
  }

  async saveSettings(settings) {
    const settingsPath = this.getSettingsPath();
    let defaultSettings = {
      serverSubnets: [],
      overrideDefaultRoute: true,
      routeDNS: true,
      strictVPN: false
    }; // default settings
    const mergedSettings = Object.assign({}, defaultSettings, settings);
    this.settings = mergedSettings;
    await writeFileAsync(settingsPath, JSON.stringify(mergedSettings), 'utf8');
  }

  async loadSettings() {
    const settingsPath = this.getSettingsPath();
    let settings = {
      serverSubnets: [],
      overrideDefaultRoute: true,
      routeDNS: true,
      strictVPN: false
    }; // default settings
    if (await accessAsync(settingsPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      const settingsContent = await readFileAsync(settingsPath, 'utf8');
      settings = Object.assign({}, settings, JSON.parse(settingsContent));
    }
    this.settings = settings;
    return settings;
  }

  _getPushOptionsPath() {
    return `${f.getHiddenFolder()}/run/ovpn_profile/${this.profileId}.push_options`;
  }

  _getGatewayFilePath() {
    return `${f.getHiddenFolder()}/run/ovpn_profile/${this.profileId}.gateway`;
  }

  _getSubnetFilePath() {
    return `${f.getHiddenFolder()}/run/ovpn_profile/${this.profileId}.subnet`;
  }

  _getStatusLogPath() {
    return `/var/log/openvpn_client-status-${this.profileId}.log`;
  }

  async _parseProfile(ovpnPath) {
    if (await accessAsync(ovpnPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
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
    if (await accessAsync(this.getPasswordPath(), fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      if (!revisedContent.match(/^askpass.*$/gm)) {
        revisedContent = `askpass ${this.getPasswordPath()}\n${revisedContent}`;
      } else {
        revisedContent = revisedContent.replace(/^askpass.*$/gm, `askpass ${this.getPasswordPath()}`);
      }
    }
    // add user/pass file to profile if present
    if (await accessAsync(this.getUserPassPath(), fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
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
    /* comp-lzo is still compatible in 2.4.x. Need to check the value of comp-lzo for proper convertion, e.g. comp-lzo (yes)-> compress lzo, comp-lzo no -> compress ...
    if (version.startsWith("2.4.")) {
      // 'comp-lzo' is deprecated in 2.4.x
      revisedContent = revisedContent.replace(/comp\-lzo/g, "compress lzo");
    }
    */
    await writeFileAsync(ovpnPath, revisedContent, 'utf8');
  }

  async _refreshRoutes() {
    if (!this._started)
      return;
    const newRemoteIP = await this.getRemoteIP();
    const intf = this.getInterfaceName();
    if (newRemoteIP) {
      log.info(`Refresh OpenVPN client routes for ${this.profileId}: ${newRemoteIP}, ${intf}`);
      const settings = this.settings || await this.loadSettings();
      await vpnClientEnforcer.enforceVPNClientRoutes(newRemoteIP, intf, (Array.isArray(settings.serverSubnets) && settings.serverSubnets) || [], settings.overrideDefaultRoute == true);
      if (this._dnsServers && this._dnsServers.length > 0) {
        if (settings.routeDNS) {
          await vpnClientEnforcer.enforceDNSRedirect(intf, this._dnsServers, newRemoteIP);
        } else {
          await vpnClientEnforcer.unenforceDNSRedirect(intf, this._dnsServers, newRemoteIP);
        }
      }
      this._remoteIP = newRemoteIP;
    }
  }

  async _checkConnectivity() {
    // no need to refresh routes if vpn client is not started
    if (!this._started) {
      return;
    }
    const newRemoteIP = await this.getRemoteIP();
    if (newRemoteIP === null) {
      // vpn client is down unexpectedly
      log.error("VPN client " + this.profileId + " remote IP is missing.");
      this.emit('link_broken');
      return;
    }
  }

  async start() {
    if (!this.profileId) {
      throw "OpenVPN client is not setup properly. Profile id is missing."
    }
    let cmd = util.format("sudo systemctl start \"%s@%s\"", SERVICE_NAME, this.profileId);
    await execAsync(cmd);
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const establishmentTask = setInterval(() => {
        (async () => {
          const remoteIP = await this.getRemoteIP();
          if (remoteIP !== null && remoteIP !== "") {
            this._remoteIP = remoteIP;
            clearInterval(establishmentTask);
            // remove routes from main table which is inserted by OpenVPN client automatically,
            // otherwise tunnel will be enabled globally
            const intf = this.getInterfaceName();
            await routing.removeRouteFromTable("0.0.0.0/1", remoteIP, intf, "main").catch((err) => {log.info("No need to remove 0.0.0.0/1 for " + this.profileId)});
            await routing.removeRouteFromTable("128.0.0.0/1", remoteIP, intf, "main").catch((err) => {log.info("No need to remove 128.0.0.0/1 for " + this.profileId)});
            await routing.removeRouteFromTable("default", remoteIP, intf, "main").catch((err) => {log.info("No need to remove default route for " + this.profileId)});
            // add vpn client specific routes
            const settings = await this.loadSettings();
            await vpnClientEnforcer.enforceVPNClientRoutes(remoteIP, intf, (Array.isArray(settings.serverSubnets) && settings.serverSubnets) || [], settings.overrideDefaultRoute == true);
            await execAsync(iptables.wrapIptables(`sudo iptables -w -t nat -A FW_POSTROUTING -o ${intf} -j MASQUERADE`)).catch((err) => {});
            for (const serverSubnet of (settings.serverSubnets || [])) {
              await execAsync(iptables.wrapIptables(`sudo iptables -w -t mangle -A FW_RT_VC_REPLY -m conntrack --ctorigsrc ${serverSubnet} -j FW_RT_VC`)).catch((err => {}));
            }
            // loosen reverse path filter
            await execAsync(`sudo sysctl -w net.ipv4.conf.${intf}.rp_filter=2`).catch((err) => {});
            await this._processPushOptions("start");
            this._started = true;
            resolve(true);
          } else {
            const now = Date.now();
            if (now - startTime > 30000) {
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

  getPushedDNSSServers() {
    return this._dnsServers || [];
  }

  async _processPushOptions(status) {
    const pushOptionsFile = this._getPushOptionsPath();
    if (await accessAsync(pushOptionsFile, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      const content = await readFileAsync(pushOptionsFile, "utf8");
      if (!content)
        return;
      // parse pushed DNS servers
      const dnsServers = [];
      for (let line of content.split("\n")) {
        if (line && line.length != 0) {
          log.info(`Processing ${status} push options from ${this.profileId}: ${line}`);
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
      }
      this._dnsServers = dnsServers;
      this.emit(`push_options_${status}`, content);
    }
  }

  async stop() {
    // flush routes before stop vpn client to ensure smooth switch of traffic routing
    const intf = this.getInterfaceName();
    this._started = false;
    await vpnClientEnforcer.flushVPNClientRoutes(intf);
    await execAsync(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_POSTROUTING -o ${intf} -j MASQUERADE`)).catch((err) => {});
    const settings = await this.loadSettings();
    for (const serverSubnet of (settings.serverSubnets || [])) {
      await execAsync(iptables.wrapIptables(`sudo iptables -w -t mangle -D FW_RT_VC_REPLY -m conntrack --ctorigsrc ${serverSubnet} -j FW_RT_VC`)).catch((err => {}));
    }
    await this._processPushOptions("stop");
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
      if (!await accessAsync(statusLogPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
        log.warn(`status log for ${this.profileId} does not exist`);
        return {};
      }
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

  async getVPNSubnet() {
    const intf = this.getInterfaceName();
    const cmd = util.format(`ip link show dev ${intf}`);
    const subnet = await execAsync(cmd).then(() => {
      const subnetFile = this._getSubnetFilePath();
      return fs.readFileAsync(subnetFile, "utf8").then((content) => content.trim());
    }).catch((err) =>{
      return null;
    });
    return subnet;
  }

  async getRemoteIP() {
    const intf = this.getInterfaceName();
    const cmd = util.format(`ip link show dev ${intf}`);
    const ip = await execAsync(cmd).then(() => {
      const gatewayFile = this._getGatewayFilePath();
      return fs.readFileAsync(gatewayFile, "utf8").then((content) => content.trim());
    }).catch((err) =>{
      return null;
    });
    return ip;
  }

  getInterfaceName() {
    if (!this.profileId) {
      throw "profile id is not defined"
    }
    return `vpn_${this.profileId}`
  }
}

module.exports = OpenVPNClient;
