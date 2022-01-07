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
const f = require('../../net2/Firewalla.js');
const VPNClient = require('./VPNClient.js');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const {Address4, Address6} = require('ip-address');
const SERVICE_NAME = "openconnect_client";

class OCVPNClient extends VPNClient {

  static getProtocol() {
    return "ssl";
  }

  _getDNSFilePath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.dns`;
  }

  _getSubnetFilePath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.network`;
  }

  _getRouteFilePath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.route`;
  }

  _getSettingsPath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.settings`;
  }

  _getPasswordPath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.password`;
  }

  _getServerPath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.server`;
  }

  _getConfigPath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.conf`;
  }

  _getJSONConfigPath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.json`;
  }

  async _generateConfig() {
    await this.loadSettings();
    let config = null;
    try {
      config = await fs.readFileAsync(this._getJSONConfigPath(), {encoding: "utf8"}).then(content => JSON.parse(content)).catch(err => null);
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    if (!config)
      return;
    const entries = [];
    const ignoredKeys = ["password", "server"];
    for (const key of Object.keys(config)) {
      if (ignoredKeys.includes(key))
        continue;
      if (config[key] !== null) {
        entries.push(`${key}=${config[key]}`); // a parameter with value
      } else {
        entries.push(`${key}`); // a parameter without value
      }
    }
    await fs.writeFileAsync(this._getConfigPath(), entries.join('\n'), {encoding: "utf8"});
  }

  async _getDNSServers() {
    const path = this._getDNSFilePath();
    const results = await fs.readFileAsync(path, {encoding: "utf8"}).then((content) => content.trim().split('\n')).catch((err) => []);
    return results;
  }

  async _start() {
    await this._generateConfig();
    const cmd = `sudo systemctl start ${SERVICE_NAME}@${this.profileId}`;
    exec(cmd);
  }

  async _stop() {
    const cmd = `sudo systemctl stop ${SERVICE_NAME}@${this.profileId}`;
    exec(cmd);
  }

  async getRoutedSubnets() {
    const isLinkUp = await this._isLinkUp();
    if (isLinkUp) {
      let results = [];
      let subnets = await fs.readFileAsync(this._getSubnetFilePath(), {encoding: "utf8"}).then((content) => content.trim().split('\n')).catch((err) => []);
      const routes = await fs.readFileAsync(this._getRouteFilePath(), {encoding: "utf8"}).then((content) => content.trim().split('\n')).catch((err) => []);
      subnets = subnets.concat(routes);
      for (const subnet of subnets) {
        let addr = new Address4(subnet);
        if (addr.isValid()) {
          results.push(`${addr.startAddress().correctForm()}/${addr.subnetMask}`);
        } else {
          addr = new Address6(subnet);
          if (addr.isValid()) {
            results.push(`${addr.startAddress().correctForm()}/${addr.subnetMask}`);
          } else {
            log.error(`Failed to parse cidr subnet ${subnet} for profile ${this.profileId}`, err.message);
          }
        }
      }
      return results;
    } else {
      return [];
    }
  }

  async _isLinkUp() {
    const intf = this.getInterfaceName();
    return exec(`ip link show dev ${intf}`).then(() => true).catch((err) => false);
  }

  async checkAndSaveProfile(value) {
    const config = value.config || {};
    const password = config.password || "";
    const server = config.server;
    if (!config.servercert)
      throw new Error("'servercert' should be specified in 'config'");
    if (!server)
      throw new Error("'server' should be specified in 'config'");
    if (!config.servercert.startsWith("sha1:") && !config.servercert.startsWith("sha256:") && !config.servercert.startsWith("pin-sha256"))
      throw new Error("'servercert' should begin with sha1:, sha256: or pin-sha256");
    config.interface = this.getInterfaceName();
    await fs.writeFileAsync(this._getPasswordPath(), password, "utf8");
    await fs.writeFileAsync(this._getServerPath(), server, "utf8");
    await fs.writeFileAsync(this._getJSONConfigPath(), JSON.stringify(config), "utf8");
  }

  async destroy() {
    await super.destroy();
    const filesToDelete = [this._getDNSFilePath(), this._getRouteFilePath(), this._getSubnetFilePath(), this._getSettingsPath(), this._getPasswordPath(), this._getConfigPath(), this._getServerPath(), this._getJSONConfigPath()];
    for (const file of filesToDelete)
      await fs.unlinkAsync(file).catch((err) => {});
  }

  static async listProfileIds() {
    const dirPath = f.getHiddenFolder() + "/run/oc_profile";
    const files = await fs.readdirAsync(dirPath);
    const profileIds = files.filter(filename => filename.endsWith('.settings')).map(filename => filename.slice(0, filename.length - 9));
    return profileIds;
  }

  async getAttributes(includeContent = false) {
    const attributes = await super.getAttributes();
    try {
      const config = require(this._getJSONConfigPath());
      attributes.config = config;
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    attributes.type = "ssl"; // openconnect is for ssl VPN client
    return attributes;
  }

}

module.exports = OCVPNClient;