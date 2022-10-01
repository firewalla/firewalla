/*    Copyright 2022 Firewalla Inc
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


const log = require('../../../net2/logger.js')(__filename);
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const DockerBaseVPNClient = require('./DockerBaseVPNClient.js');
const YAML = require('../../../vendor_lib/yaml/dist');
const _ = require('lodash');
const f = require('../../../net2/Firewalla.js');

class OCDockerClient extends DockerBaseVPNClient {

  async prepareConfig(config) {
    log.info("Preparing config file...");

    if (!config)
      return;

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
    const dst = `${this._getDockerConfigDirectory()}/oc.conf`;
    await fs.writeFileAsync(dst, entries.join('\n'), {encoding: 'utf8'}) ;
  }

  _getOutputDirectory() {
    return `${f.getHiddenFolder()}/run/docker/${this.profileId}/output`;
  }

  async _getDNSServersFromFile(file) {
    try {
      const str = await fs.readFileAsync(file, {encoding: 'utf8'});
      const ips = str.split(" ");

      if(!_.isEmpty(ips)) {
        return ips;
      }

    } catch(err) {
      log.error("Got error when getting DNS servers from file, err:", err);
    }

    return [];
  }

  async _getDNSServers() {
    const ipv4s = await this._getDNSServersFromFile(`${this._getOutputDirectory()}/nameserver.ipv4`);
    const ipv6s = await this._getDNSServersFromFile(`${this._getOutputDirectory()}/nameserver.ipv6`);

    return [...ipv4s, ...ipv6s]
      .map((x) => x.trim())
      .filter((x) => x !== "");
  }

  async _autoReconnectNeeded() {
    const config = await this.loadJSONConfig();
    if (config && _.isString(config.password) && config.password.includes("\n")) // do not restart vpn if mfa token is used in password
      return false;
    return super._autoReconnectNeeded();
  }

  async getMessage() {
    const file = `${this._getOutputDirectory()}/message`;
    return await fs.readFileAsync(file, {encoding: "utf8"}).catch(() => "");
  }

  async getRoutedSubnets() {
    try {
      const base = await super.getRoutedSubnets() || [];
      const file = `${this._getOutputDirectory()}/routes`;

      const str = await fs.readFileAsync(file, {encoding: 'utf8'});
      const routes = str.split(",");

      if(!_.isEmpty(routes)) {
        return _.uniq(routes
          .map((x) => x.trim())
          .filter((x) => x !== "").concat(base));
      }

    } catch(err) {
      log.error("Got error when getting routes from file, err:", err);
    }

    return [];
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    const yamlJSON = {
      version: "3",
      services: {
        ssl: {
          image: `public.ecr.aws/a0j1s2e9/openconnect:${f.isDevelopmentVersion() ? "dev" : "latest"}`,
          volumes: [
            "./:/etc/openconnect/",
            "./output:/output/"
          ],
          cap_add: [
            "NET_ADMIN"
          ]
        }
      }
    };

    await this._prepareDockerCompose(yamlJSON);
    await this._prepareFile(config, "password", "passwd");
    await this._prepareFile(config, "server", "server");
    if (_.isEmpty(config.mfaSeed))
      // empty seed file will be omitted in OpenConnect docker container, this is to ensure the legacy seed file will be overwritten if mfaSeed is not set in new config
      config.mfaSeed = "";
    await this._prepareFile(config, "mfaSeed", "seed");
    await this.prepareConfig(config);
  }

  async _prepareFile(config = {}, key, filename) {
    log.info(`Preparing file ${filename} for ${this.profileId}...`);
    const dst = `${this._getDockerConfigDirectory()}/${filename}`;
    await fs.writeFileAsync(dst, config[key], {encoding: 'utf8'});
  }

  async __isLinkUpInsideContainer() {
    try {
      const reason = await fs.readFileAsync(`${this._getOutputDirectory()}/reason`, {encoding: 'utf8'});

      // reference: https://gitlab.com/openconnect/vpnc-scripts/raw/master/vpnc-script
      return ["connect", "reconnect"].includes(reason.trim());
    } catch(err) { // e.g. file not exists, means service is not up
      return false;
    }
  }

  // use same directory as OCVPNClient.js, so that different implementations for the same protocol can be interchanged
  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/oc_profile`;
  }

  static getProtocol() {
    return "ssl";
  }

  static getKeyNameForInit() {
    return "sslvpnClientProfiles";
  }

  getEffectiveInterface() {
    return "tun0";
  }

}

module.exports = OCDockerClient;
