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
const f = require('../../../net2/Firewalla.js');
const sysManager = require('../../../net2/SysManager.js')
const _ = require('lodash');

class ClashDockerClient extends DockerBaseVPNClient {

  async prepareDockerCompose(config) {
    log.info("Preparing docker compose file");
    const src = `${__dirname}/clash/docker-compose.template.yaml`;
    const content = await fs.readFileAsync(src, {encoding: 'utf8'});
    const dst = `${this._getConfigDirectory()}/docker-compose.yaml`;
    log.info("Writing config file", dst);
    await fs.writeFileAsync(dst, content);
  }

  async prepareClashConfig(config) {
    log.info("Preparing clash config file");
    const src = `${__dirname}/clash/config.template.yml`;
    const dst = `${this._getConfigDirectory()}/config.yml`;

    const content = await fs.readFileAsync(src, {encoding: 'utf8'});
    const yamlObj = YAML.parse(content);

    if(yamlObj.dns && yamlObj.dns["default-nameserver"]) {
      yamlObj.dns["default-nameserver"] = sysManager.myDefaultDns();
    }

    if(yamlObj.dns && yamlObj.dns["nameserver"]) {
      yamlObj.dns["nameserver"] = sysManager.myDefaultDns();
    }

    if(config.proxies) {
      yamlObj.proxies = config.proxies;
    } else {
      log.error("Missing proxies config");
    }

    if(config["proxy-groups"]) {
      yamlObj["proxy-groups"] = config["proxy-groups"];
    } else {
      log.error("Missing proxy-groups config");
    }

    log.info("Writing config file", dst);
    await fs.writeFileAsync(dst, YAML.stringify(yamlObj));
  }

  async __prepareAssets() {
    const config = await this.loadOriginalUserConfig();

    if(_.isEmpty(config)) return;

    await exec(`touch ${f.getUserHome()}/.forever/clash.log`); // prepare the log file
    await this.prepareDockerCompose(config);
    await this.prepareClashConfig(config);
  }

  static getProtocol() {
    return "clash";
  }

  static getDNSPort() {
    return 9953;
  }

  async _getDNSServers() {
    const remoteIP = await this._getRemoteIP();
    return [remoteIP];
  }
}

module.exports = ClashDockerClient;
