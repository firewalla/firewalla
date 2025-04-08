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

class GostDockerClient extends DockerBaseVPNClient {

  get_url(config = {}) {
    let {username, password, server, port} = config;
    if (!username || !password || !server || !port) {
      return null;
    }
    return `https://${username}:${password}@${server}:${port}/`;
  }

  async prepareConfig(config) {
    log.verbose("Preparing gost config file");
    const src = `${__dirname}/gost/config.template.env`;
    const dst = `${this._getDockerConfigDirectory()}/config.env`;

    let url = this.get_url(config);
    if (!url) {
      log.error("Invalid gost config", config);
      return;
    }

    const template_content = await fs.promises.readFile(src, {encoding: 'utf8'});
    let content = template_content.replace("__GOST_SERVER_URL__", url);

    log.info("Writing config file", dst);
    await fs.promises.writeFile(dst, content);
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    await this._prepareDockerCompose();
    await this.prepareConfig(config);
  }

  static getProtocol() {
    return "gost";
  }

  static getKeyNameForInit() {
    return "gostVpnClientProfiles";
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/gost_profile`;
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
    // a self-made gost_stats.sh script to get the stats
    const result = await exec(`sudo docker exec ${this.getContainerName()} gost_stats.sh`)
    .then(output => output.stdout.trim())
    .catch((err) => {
      log.error(`Failed to check gost stats on ${this.profileId}`, err.message);
      return super.getStatistics();
    });

    // return zero if invalid
    if (!result || !_.isString(result))
      return {bytesIn: 0, bytesOut: 0};

    let items = result.split(" ");
    if (items.length != 2) {
      log.error(`Invalid gost stats on ${this.profileId}`, result);
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

module.exports = GostDockerClient;
