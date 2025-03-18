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
const sem = require('../../../sensor/SensorEventManager.js').getInstance();
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const DockerBaseVPNClient = require('./DockerBaseVPNClient.js');
const YAML = require('../../../vendor_lib/yaml/dist');
const f = require('../../../net2/Firewalla.js');
const sysManager = require('../../../net2/SysManager.js')
const _ = require('lodash');

const vpnClientEnforcer = require('../VPNClientEnforcer.js');

class ClashDockerClient extends DockerBaseVPNClient {

  async prepareConfig(config) {
    log.info("Preparing clash config file");
    const src = `${__dirname}/clash/config.template.yml`;
    const dst = `${this._getDockerConfigDirectory()}/config.yml`;

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
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    await exec(`touch ${f.getUserHome()}/.forever/clash.log`); // prepare the log file
    await this._prepareDockerCompose();
    await this.prepareConfig(config);
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

  static getProtocol() {
    return "clash";
  }

  static getKeyNameForInit() {
    return "clashvpnClientProfiles";
  }

  async _getDNSServers() {
    const remoteIP = await this._getRemoteIP();
    return [remoteIP];
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/clash_profile`;
  }

  async getStatistics() {
    // a self-made hy_stats.sh script to get the stats
    const result = await exec(`sudo docker exec ${this.getContainerName()} clash_stats.sh`)
    .then(output => output.stdout.trim())
    .catch((err) => {
      log.error(`Failed to check clash stats on ${this.profileId}`, err.message);
      return super.getStatistics();
    });

    if (!result)
      return {bytesIn: 0, bytesOut: 0};

    let items = result.split(" ");
    if (items.length != 2) {
      log.error(`Invalid clash stats on ${this.profileId}`, result);
      return {bytesIn: 0, bytesOut: 0};
    }

    let txBytes = Number(items[0]);
    let rxBytes = Number(items[1]);
    return {bytesIn: rxBytes, bytesOut: txBytes};
  }

  isIPv6Enabled() {
    // only enable in dev, may change in the future
    return f.isDevelopmentVersion();
  }
}

module.exports = ClashDockerClient;
