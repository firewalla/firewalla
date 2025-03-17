/*    Copyright 2023-2024 Firewalla Inc.
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
const exec = require('child-process-promise').exec;
const DockerBaseVPNClient = require('./DockerBaseVPNClient.js');
const YAML = require('../../../vendor_lib/yaml/dist');
const f = require('../../../net2/Firewalla.js');
const _ = require('lodash');

class HysteriaDockerClient extends DockerBaseVPNClient {

  async prepareConfig(config) {
    log.verbose("Preparing hysteria config file");
    const src = `${__dirname}/hysteria/config.template.yml`;
    const dst = `${this._getDockerConfigDirectory()}/config.yml`;

    const content = await fs.promises.readFile(src, {encoding: 'utf8'});
    const yamlObj = YAML.parse(content);

    if(config.server) {
      yamlObj.server = config.server;
    }

    if(config.password) {
      yamlObj.auth = config.password;
    }

    // configure bandwidth
    yamlObj.bandwidth = config.bandwidth || {};

    config.down = config.down || 80;
    config.up = config.up || 50;

    yamlObj.bandwidth.down = `${config.down} mbps`;
    yamlObj.bandwidth.up = `${config.up} mbps`;

    log.info("Writing config file", dst);
    await fs.promises.writeFile(dst, YAML.stringify(yamlObj));
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    await this._prepareDockerCompose();
    await this.prepareConfig(config);
  }

  static getProtocol() {
    return "hysteria";
  }

  static getKeyNameForInit() {
    return "hysteriaVpnClientProfiles";
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/hysteria_profile`;
  }

  // hard code is okay
  async _getDNSServers() {
    return ["1.0.0.1", "8.8.8.8", "9.9.9.9"];
  }

  async __checkInternetAvailability(target) {
    const script = `${f.getFirewallaHome()}/scripts/test_wan.sh`;
    const intf = this.getInterfaceName();
    // triple backslash to escape the dollar sign on sudo bash
    const cmd = `sudo ${script} ${intf} curl -m 5 -s -o /dev/null ${target}`;
    const result = await exec(cmd).then(() => true).catch((err) => false);
    return result;
  }

  async _checkInternetAvailability() {
    const targets = [
      "https://1.1.1.1",
      "https://8.8.8.8",
      "https://9.9.9.9"
    ];

    for (const target of targets) {
      const result = await this.__checkInternetAvailability(target);
      if (result) {
        return true;
      }
    }

    return false;
  }

  async getStatistics() {
    // a self-made hy_stats.sh script to get the stats
    const result = await exec(`sudo docker exec ${this.getContainerName()} hy_stats.sh`)
    .then(output => output.stdout.trim())
    .catch((err) => {
      log.error(`Failed to check hysteria stats on ${this.profileId}`, err.message);
      return super.getStatistics();
    });

    if (!result)
      return {bytesIn: 0, bytesOut: 0};

    let items = result.split(" ");
    if (items.length != 2) {
      log.error(`Invalid hysteria stats on ${this.profileId}`, result);
      return {bytesIn: 0, bytesOut: 0};
    }

    let txBytes = Number(items[0]);
    let rxBytes = Number(items[1]);
    return {bytesIn: rxBytes, bytesOut: txBytes};
  }

  isIPv6Enabled() {
    return true
  }
}

module.exports = HysteriaDockerClient;
