/*    Copyright 2023 Firewalla Inc
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
const dns = require('dns');
const f = require('../../../net2/Firewalla.js');
const resolve4 = Promise.promisify(dns.resolve4);
const _ = require('lodash');
const sem = require('../../../sensor/SensorEventManager.js').getInstance();
const vpnClientEnforcer = require('../VPNClientEnforcer.js');

class HysteriaDockerClient extends DockerBaseVPNClient {

  async prepareConfig(config) {
    log.info("Preparing hysteria config file");
    const src = `${__dirname}/hysteria/config.template.yml`;
    const dst = `${this._getDockerConfigDirectory()}/config.yml`;

    const content = await fs.readFileAsync(src, {encoding: 'utf8'});
    const yamlObj = YAML.parse(content);

    if(config.server) {
      yamlObj.server = config.server;
    }

    if(config.password) {
      yamlObj.auth = config.password;
    }

    log.info("Writing config file", dst);
    await fs.writeFileAsync(dst, YAML.stringify(yamlObj));
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

  async _checkInternetAvailability() {
    // temporarily comment out
    return true;
    const script = `${f.getFirewallaHome()}/scripts/test_vpn_docker.sh`;
    const intf = this.getInterfaceName();
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    // triple backslash to escape the dollar sign on sudo bash
    const cmd = `sudo ${script} ${intf} ${rtId} "test 200 -eq \\\$(curl -s -m 5 -o /dev/null -I -w '%{http_code}' https://1.1.1.1)"`
    const result = await exec(cmd).then(() => true).catch((err) => false);
    return result;
  }
}

module.exports = HysteriaDockerClient;
