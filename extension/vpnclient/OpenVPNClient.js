/*    Copyright 2016 - 2021 Firewalla Inc 
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
const util = require('util');
const f = require('../../net2/Firewalla.js');

const Message = require('../../net2/Message.js');
const VPNClient = require('./VPNClient.js');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const iptool = require('ip');

const SERVICE_NAME = "openvpn_client";

class OpenVPNClient extends VPNClient {
  static getProtocol() {
    return "openvpn";
  }

  static getKeyNameForInit() {
    return "ovpnClientProfiles";
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/ovpn_profile`;
  }

  async getVpnIP4s() {
    const ip4File = this._getIP4FilePath();
    const ips = await fs.readFileAsync(ip4File, "utf8").then((content) => content.trim().split('\n')).catch((err) => {
      log.error(`Failed to read IPv4 address file of vpn ${this.profileId}`, err.message);
      return null;
    });
    return ips;
  }

  _getRedisRouteUpMessageChannel() {
    return Message.MSG_OVPN_CLIENT_ROUTE_UP;
  }

  _getProfilePath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".ovpn";
    return path;
  }

  _getRuntimeProfilePath() {
    const path = `${f.getHiddenFolder()}/run/ovpn_profile/${this.profileId}.conf`;
    return path;
  }

  _getPasswordPath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".password";
    return path;
  }

  _getUserPassPath() {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + this.profileId + ".userpass";
    return path;
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

  _getIP4FilePath() {
    return `${f.getHiddenFolder()}/run/ovpn_profile/${this.profileId}.ip4`;
  }

  async _cleanupLogFiles() {
    await exec(`sudo rm /var/log/openvpn_client-status-${this.profileId}.log*`).catch((err) => {});
    await exec(`sudo rm /var/log/openvpn_client-${this.profileId}.log*`).catch((err) => {});
  }

  async _parseProfile(ovpnPath) {
    if (await fs.accessAsync(ovpnPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      const content = await fs.readFileAsync(ovpnPath, {encoding: 'utf8'});
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
      throw new Error(util.format("ovpn file %s is not found", ovpnPath));
    }
  }

  async _generateRuntimeProfile() {
    const ovpnPath = this._getProfilePath();
    if (await fs.accessAsync(ovpnPath, fs.constants.R_OK).then(() => true).catch((err) => false) === false) {
      throw new Error(`ovpn file ${ovpnPath} is not found`);
    }
    const cmd = "openvpn --version | head -n 1 | awk '{print $2}'";
    const result = await exec(cmd);
    const version = result.stdout;
    let content = await fs.readFileAsync(ovpnPath, {encoding: 'utf8'});
    let revisedContent = content;
    const intf = this.getInterfaceName();
    await this._parseProfile(ovpnPath);
    // used customized interface name
    if (!revisedContent.includes(`dev ${intf}`)) {
      revisedContent = revisedContent.replace(/^dev\s+.*$/gm, `dev ${intf}`);
    }
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
    if (await fs.accessAsync(this._getPasswordPath(), fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      if (!revisedContent.includes(`askpass ${this._getPasswordPath()}`)) {
        if (!revisedContent.match(/^askpass.*$/gm)) {
          revisedContent = `askpass ${this._getPasswordPath()}\n${revisedContent}`;
        } else {
          revisedContent = revisedContent.replace(/^askpass.*$/gm, `askpass ${this._getPasswordPath()}`);
        }
      }
    }
    // add user/pass file to profile if present
    if (await fs.accessAsync(this._getUserPassPath(), fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      if (!revisedContent.includes(`auth-user-pass ${this._getUserPassPath()}`)) {
        if (!revisedContent.match(/^auth-user-pass.*$/gm)) {
          revisedContent = `auth-user-pass ${this._getUserPassPath()}\n${revisedContent}`;
        } else {
          revisedContent = revisedContent.replace(/^auth-user-pass.*$/gm, `auth-user-pass ${this._getUserPassPath()}`);
        }
      }
    }
    // resolve remote domain to IP if it ends with firewalla.org to prevent ddns propagation delay
    const remoteReg = /^\s*remote\s+(\S+)\s+([0-9]+)\s*$/m;
    const remoteRegMatch = revisedContent.match(remoteReg);
    if (remoteRegMatch) {
      let [host, port] = [remoteRegMatch[1], remoteRegMatch[2]];
      if (host && port) {
        if (host.includes("firewalla.org") || host.includes("firewalla.com")) {
          host = await this.resolveFirewallaDDNS(host);
          if (host)
            revisedContent = revisedContent.replace(/^\s*remote\s+[\S]+\s+[0-9]+\s*$/gm, `remote ${host} ${port}`);
        }
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
                throw new Error(util.format("Unsupported compress algorithm for OpenVPN 2.3: %s", algorithm));
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
    // add management socket
    if (!revisedContent.includes(`management /dev/${this.getInterfaceName()} unix`)) {
      if (!revisedContent.match(/^management\s+.*/gm)) {
        revisedContent = `${revisedContent}\nmanagement /dev/${this.getInterfaceName()} unix`
      } else {
        revisedContent = revisedContent.replace(/^management\s+.*/gm, `management /dev/${this.getInterfaceName()} unix`);
      }
    }
    
    const runtimeOvpnPath = this._getRuntimeProfilePath();
    await fs.writeFileAsync(runtimeOvpnPath, revisedContent, {encoding: 'utf8'});
  }

  async _getDNSServers() {
    const pushOptionsFile = this._getPushOptionsPath();
    const dnsServers = [];
    if (await fs.accessAsync(pushOptionsFile, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      const content = await fs.readFileAsync(pushOptionsFile, {encoding: "utf8"});
      if (!content)
        return;
      // parse pushed DNS servers
      for (let line of content.split("\n")) {
        if (line && line.length != 0) {
          log.info(`Parsing push options from ${this.profileId}: ${line}`);
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
    }
    return dnsServers;
  }

  async _start() {
    const profileId = this.profileId;
    if (!profileId)
      throw new Error("profileId is not set");
    await this._generateRuntimeProfile();
    let cmd = util.format("sudo systemctl start \"%s@%s\"", SERVICE_NAME, this.profileId);
    await exec(cmd);
  }

  async _stop() {
    let cmd = util.format("sudo systemctl stop \"%s@%s\"", SERVICE_NAME, this.profileId);
    await exec(cmd).catch((err) => {
      log.error(`Failed to stop openvpn client ${this.profileId}`, err.message);
    });
    cmd = util.format("sudo systemctl disable \"%s@%s\"", SERVICE_NAME, this.profileId);
    await exec(cmd).catch((err) => {});
  }

  async checkAndSaveProfile(value) {
    const content = value.content;
    const password = value.password;
    const user = value.user;
    const pass = value.pass;
    if (!content) {
      throw new Error("'content' should be specidied");
    }
    if (content.match(/^auth-user-pass\s*/gm)) {
      // username password is required for this profile
      if (!user || !pass) {
        throw new Error("'user' and 'pass' should be specified for this profile");
      }
    }
    const profilePath = this._getProfilePath();
    await fs.writeFileAsync(profilePath, content, 'utf8');
    if (password) {
      const passwordPath = this._getPasswordPath();
      await fs.writeFileAsync(passwordPath, password, 'utf8');
    }
    if (user && pass) {
      const userPassPath = this._getUserPassPath();
      await fs.writeFileAsync(userPassPath, `${user}\n${pass}`, 'utf8');
    }
  }

  async getRoutedSubnets() {
    const intf = this.getInterfaceName();
    const cmd = util.format(`ip link show dev ${intf}`);
    const subnets = await exec(cmd).then(() => {
      const subnetFile = this._getSubnetFilePath();
      return fs.readFileAsync(subnetFile, "utf8").then((content) => content.trim().split("\n"));
    }).catch((err) =>{
      return null;
    });
    let results = []
    // subnet is like xx.xx.xx.xx/255.255.255.0
    if (subnets) {
      for (const subnet of subnets) {
        const [network, mask] = subnet.split("/", 2);
        if (!network || !mask)
          continue;
        try {
          const ipSubnet = iptool.subnet(network, mask);
          results.push(`${ipSubnet.networkAddress}/${ipSubnet.subnetMaskLength}`);
        } catch (err) {
          log.error(`Failed to parse cidr subnet ${subnet} for profile ${this.profileId}`, err.message);
        }
      }
    }
    return results;
  }

  async _isLinkUp() {
    const remoteIP = await this._getRemoteIP();
    if (remoteIP) {
      const connected = await exec(`echo "state" | nc -U /dev/${this.getInterfaceName()} -q 0 -w 5 | tail -n +2 | head -n 1 | awk -F, '{print $2}'`).then((result) => result.stdout.trim() === "CONNECTED").catch((err) => {
        log.error(`Failed to get state of vpn client ${this.profileId} from socket /dev/${this.getInterfaceName()}`, err.message);
        // conservatively return true in case the unix domain socket file does not exist because openvpn_client service is not restarted after upgrade
        return true;
      });
      return connected;
    }
    else
      return false;
  }

  async _getRemoteIP() {
    const intf = this.getInterfaceName();
    const cmd = util.format(`ip link show dev ${intf}`);
    const ip = await exec(cmd).then(() => {
      const gatewayFile = this._getGatewayFilePath();
      return fs.readFileAsync(gatewayFile, "utf8").then((content) => content.trim());
    }).catch((err) =>{
      return null;
    });
    return ip;
  }

  async destroy() {
    await super.destroy();
    const filesToDelete = [this._getProfilePath(), this._getRuntimeProfilePath(), this._getUserPassPath(), this._getPasswordPath(), this._getGatewayFilePath(), this._getPushOptionsPath(), this._getSubnetFilePath(), this._getIP4FilePath()];
    for (const file of filesToDelete)
      await fs.unlinkAsync(file).catch((err) => {});
    await this._cleanupLogFiles();
  }

  static async listProfileIds() {
    const dirPath = f.getHiddenFolder() + "/run/ovpn_profile";
    const files = await fs.readdirAsync(dirPath);
    const profileIds = files.filter(filename => filename.endsWith('.ovpn')).map(filename => filename.slice(0, filename.length - 5));
    return profileIds;
  }

  async getAttributes(includeContent = false) {
    const attributes = await super.getAttributes();
    const passwordPath = this._getPasswordPath();
    let password = "";
    if (await fs.accessAsync(passwordPath, fs.constants.R_OK).then(() => true).catch(() => false)) {
      password = await fs.readFileAsync(passwordPath, "utf8");
      if (password === "dummy_ovpn_password")
        password = ""; // not a real password, just a placeholder
    }
    const userPassPath = this._getUserPassPath();
    let user = "";
    let pass = "";
    if (await fs.accessAsync(userPassPath, fs.constants.R_OK).then(() => true).catch(() => false)) {
      const userPass = await fs.readFileAsync(userPassPath, "utf8");
      const lines = userPass.split("\n", 2);
      if (lines.length == 2) {
        user = lines[0];
        pass = lines[1];
      }
    }
    if (includeContent) {
      const profilePath = this._getProfilePath();
      const content = await fs.readFileAsync(profilePath, "utf8").catch((err) => {
        log.error(`Failed to read profile content of ${this.profileId}`, err.message);
        return null;
      });
      attributes.content = content;
    }
    attributes.user = user;
    attributes.pass = pass;
    attributes.password = password;
    attributes.type = "openvpn";
    return attributes;
  }
}

module.exports = OpenVPNClient;
