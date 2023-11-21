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
const dns = require('dns');
const f = require('../../../net2/Firewalla.js');
const resolve4 = Promise.promisify(dns.resolve4);
const _ = require('lodash');
const sem = require('../../../sensor/SensorEventManager.js').getInstance();
const vpnClientEnforcer = require('../VPNClientEnforcer.js');

class TrojanDockerClient extends DockerBaseVPNClient {

  async prepareConfig(config) {
    log.info("Preparing trojan config file");
    const src = `${__dirname}/trojan/config.template.json`;
    const dst = `${this._getDockerConfigDirectory()}/config.json`;
    const template = require(src);
    const merged = Object.assign({}, template, config) ;
    await fs.writeFileAsync(dst, JSON.stringify(merged));
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    // prepare the log file in advance, otherwise, it will be created as a directory when docker container starts up
    await exec(`touch ${f.getUserHome()}/.forever/clash.log`);
    await this._prepareDockerCompose();
    await this.prepareConfig(config);
  }

  static getProtocol() {
    return "trojan";
  }

  static getKeyNameForInit() {
    return "trojanvpnClientProfiles";
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/trojan_profile`;
  }

  // hard code is okay
  async _getDNSServers() {
    return ["1.0.0.1"];
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

module.exports = TrojanDockerClient;
