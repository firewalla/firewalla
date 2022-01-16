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

class TrojanDockerClient extends DockerBaseVPNClient {

  async prepareDockerCompose() {
    log.info("Preparing docker compose file");
    const src = `${__dirname}/trojan/docker-compose.yaml`;
    const dst = `${this._getConfigDirectory()}/docker-compose.yaml`;
    const content = await fs.readFileAsync(src);
    await fs.writeFileAsync(dst, content);
  }

  async prepareTrojanConfig() {
    log.info("Preparing trojan config file");
    // FIXME: config.json has placeholders, which should be configured with real configs
    const src = `${__dirname}/trojan/config.json`;
    const dst = `${this._getConfigDirectory()}/config.json`;
    const content = await fs.readFileAsync(src);
    await fs.writeFileAsync(dst, content);
  }

  async __prepareAssets() {
    log.info("preparing assets...");
    await this.prepareDockerCompose();
    await this.prepareTrojanConfig();
  }

  async checkAndSaveProfile(value) {
    log.info("setting up config file...");

    await exec(`mkdir -p ${this._getConfigDirectory()}`);
    // const content = value.content;
    // let config = value.config || {};
    // if (content) {
    //   const convertedConfig = WGDockerClient.convertPlainTextToJson(content);
    //   config = Object.assign({}, convertedConfig, config);
    // }
    // if (Object.keys(config).length === 0) {
    //   throw new Error("either 'config' or 'content' should be specified");
    // }
    // await fs.writeFileAsync(this._getJSONConfigPath(), JSON.stringify(config), {encoding: "utf8"});
    await this.prepareTrojanConfig();
  }

  static getProtocol() {
    return "trojan";
  }
}
