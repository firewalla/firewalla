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

  async prepareDockerCompose() {
    log.info("Preparing docker compose file...");
    const src = `${__dirname}/oc/docker-compose.template.yaml`;
    const content = await fs.readFileAsync(src, {encoding: 'utf8'});
    const dst = `${this._getConfigDirectory()}/docker-compose.yaml`;
    log.info("Writing config file", dst);
    await fs.writeFileAsync(dst, content);
  }

  async prepareConfig(config) {
    log.info("Preparing config file...");

    if (!config)
      return;

    const entries = [];
    const ignoredKeys = ["password", "server"];
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
    const dst = `${this._getConfigDirectory()}/oc.conf`;
    await fs.writeFileAsync(dst, entries.join('\n'), {encoding: 'utf8'}) ;
  }

  async preparePasswd(config = {}) {
    log.info("Preparing passwd file...");
    const dst = `${this._getConfigDirectory()}/passwd`;
    await fs.writeFileAsync(dst, config.password, {encoding: 'utf8'});
  }

  async prepareServer(config = {}) {
    log.info("Preparing server file...");
    const dst = `${this._getConfigDirectory()}/server`;
    await fs.writeFileAsync(dst, config.server, {encoding: 'utf8'});
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
    const ipv4s = this._getDNSServersFromFile(`${this._getOutputDirectory()}/nameserver.ipv4`);
    const ipv6s = this._getDNSServersFromFile(`${this._getOutputDirectory()}/nameserver.ipv6`);

    return [...ipv4s, ...ipv6s];
  }

  async getRoutedSubnets() {
    try {
      const base = await super.getRoutedSubnets();
      const file = `${this._getOutputDirectory()}/routes`;

      const str = await fs.readFileAsync(file, {encoding: 'utf8'});
      const routes = str.split("\n");

      if(!_.isEmpty(routes)) {
        return routes.filter((x) => x !== "");
      }

    } catch(err) {
      log.error("Got error when getting routes from file, err:", err);
    }

    return [];
  }

  async __prepareAssets() {
    const config = await this.loadOriginUserConfig();

    if(_.isEmpty(config)) return;

    await this.prepareDockerCompose(config);
    await this.preparePasswd(config);
    await this.prepareServer(config);
    await this.prepareConfig(config);
  }

  static getProtocol() {
    return "oc";
  }

}

module.exports = OCDockerClient;
