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

class IPSecDockerClient extends DockerBaseVPNClient {

  async _getDNSServers() {
    return ["1.1.1.1"];
  }

  async getRoutedSubnets() {
    return [];
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    await this._prepareDockerCompose();
    await this._prepareFile(config, "password", "password");
    await this._prepareFile(config, "identity", "identity");
    await this._prepareFile(config, "server", "server");
    await this._prepareBase64File(config, "client.p12", "client.p12");
  }

  async __isLinkUpInsideContainer() {
    return true; // TODO
  }

  static getProtocol() {
    return "ipsec";
  }

  getEffectiveInterface() {
    return "ipsec0";
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/ipsec_profile`;
  }

  static getKeyNameForInit() {
    return "ipsecvpnClientProfiles";
  }

  async _prepareFile(config = {}, key, filename) {
    log.info(`Preparing file ${filename} for ${this.profileId}...`);
    const dst = `${this._getDockerConfigDirectory()}/${filename}`;
    await fs.writeFileAsync(dst, config[key], {encoding: 'utf8'});
  }

  async _prepareBase64File(config = {}, key, filename) {
    log.info(`Preparing file ${filename} for ${this.profileId}...`);
    const dst = `${this._getDockerConfigDirectory()}/${filename}`;
    const data = config[key];
    if(!data) {
      log.error("Missing data for key", key);
      return;
    }
    const buf = Buffer.from(data, 'base64');
    await fs.writeFileAsync(dst, buf);
  }

}

module.exports = IPSecDockerClient;
