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
const _ = require('lodash');

class OCVPNClient extends VPNClient {

  static getProtocol() {
    return "ssl";
  }

  static getKeyNameForInit() {
    return "sslvpnClientProfiles";
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/oc_profile`;
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

  _getPasswordPath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.password`;
  }

  _getServerPath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.server`;
  }

  _getConfigPath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.conf`;
  }

  _getSeedFilePath() {
    return `${f.getHiddenFolder()}/run/oc_profile/${this.profileId}.seed`;
  }

  async _generateConfig() {
    await this.loadSettings();
    let config = null;
    try {
      config = await this.loadJSONConfig().catch(err => null);
    } catch (err) {
      log.error(`Failed to read JSON config of profile ${this.profileId}`, err.message);
    }
    if (!config)
      return;
    config.interface = this.getInterfaceName();
    const entries = [];
    const ignoredKeys = ["password", "server", "mfaSeed"];
    for (const key of Object.keys(config)) {
      if (ignoredKeys.includes(key))
        continue;
      if (config[key] !== null) {
        if (_.isArray(config[key])) {
          // parameter will be specified multiple times in config file if it is an array
          for (const value of config[key]) {
            if (value !== null)
              entries.push(`${key}=${value}`);
            else
              entries.push(`${key}`);
          }
        } else
          entries.push(`${key}=${config[key]}`);
      } else {
        entries.push(`${key}`); // a parameter without value
      }
    }
    await fs.writeFileAsync(this._getConfigPath(), entries.join('\n'), {encoding: "utf8"});
    const password = config.password;
    const server = config.server;
    await fs.writeFileAsync(this._getPasswordPath(), password, {encoding: "utf8"});
    await fs.writeFileAsync(this._getServerPath(), server, {encoding: "utf8"});
    if (_.isEmpty(config.mfaSeed))
    // empty seed file will be omitted in oc_start.sh, this is to ensure the legacy seed file will be overwritten if mfaSeed is not set in new config
      config.mfaSeed = "";
    await fs.writeFileAsync(this._getSeedFilePath(), config.mfaSeed, {encoding: "utf8"});
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

  async _autoReconnectNeeded() {
    const config = await this.loadJSONConfig();
    if (config && _.isString(config.password) && config.password.includes("\n")) // do not restart vpn if mfa token is used in password
      return false;
    return super._autoReconnectNeeded();
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
          const cidr = `${addr.startAddress().correctForm()}/${addr.subnetMask}`;
          // do not add default route to routed subnets, it should be controlled by settings.overrideDefaultRoute
          if (cidr !== "0.0.0.0/0")
            results.push(cidr);
        } else {
          addr = new Address6(subnet);
          if (addr.isValid()) {
            const cidr = `${addr.startAddress().correctForm()}/${addr.subnetMask}`;
            if (cidr !== "::/0")
              results.push(cidr);
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
    const server = config.server;
    if (!_.isEmpty(config.servercert)) {
      if (!_.isString(config.servercert) && !_.isArray(config.servercert))
        throw new Error("'servercert' should be specified in 'config'");
      if (!server)
        throw new Error("'server' should be specified in 'config'");
      if (_.isString(config.servercert)) {
        if (!config.servercert.startsWith("sha1:") && !config.servercert.startsWith("sha256:") && !config.servercert.startsWith("pin-sha256"))
          throw new Error("'servercert' should begin with sha1:, sha256: or pin-sha256");
      }
      // multiple "servercert" parameter in openconnect config file is not supported yet as of v8.10, but it may be supported in the future version
      if (_.isArray(config.servercert)) {
        for (const cert of config.servercert) {
          if (!cert.startsWith("sha1:") && !cert.startsWith("sha256:") && !cert.startsWith("pin-sha256"))
            throw new Error("'servercert' should begin with sha1:, sha256: or pin-sha256");
        }
      }
    }
    await this.saveJSONConfig(config);
  }

  async destroy() {
    await super.destroy();
    const filesToDelete = [this._getDNSFilePath(), this._getRouteFilePath(), this._getSubnetFilePath(), this._getPasswordPath(), this._getConfigPath(), this._getServerPath(), this._getSeedFilePath()];
    for (const file of filesToDelete)
      await fs.unlinkAsync(file).catch((err) => {});
  }

}

module.exports = OCVPNClient;