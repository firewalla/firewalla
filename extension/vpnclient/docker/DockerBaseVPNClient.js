/*    Copyright 2016 - 2021 Firewalla Inc 
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
const f = require('../../../net2/Firewalla.js');
const VPNClient = require('../VPNClient.js');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const {Address4, Address6} = require('ip-address');
const {BigInteger} = require('jsbn');
const sysManager = require('../../../net2/SysManager.js');
const YAML = require('../../../vendor_lib/yaml');
const iptables = require('../../../net2/Iptables.js');
const wrapIptables = iptables.wrapIptables;
const routing = require('../../routing/routing.js');
const scheduler = require('../../../util/scheduler.js');
const _ = require('lodash');

class DockerBaseVPNClient extends VPNClient {

  static async listProfileIds() {
    const dirPath = f.getHiddenFolder() + `/run/docker_vpn_client/${this.getProtocol()}`;
    const files = await fs.readdirAsync(dirPath).catch(() => []); // return empty array if dir not exists
    const profileIds = files.filter(filename => filename.endsWith('.settings')).map(filename => filename.slice(0, filename.length - ".settings".length));
    return profileIds;
  }

  _getSettingsPath() {
    return `${f.getHiddenFolder()}/run/docker_vpn_client/${this.constructor.getProtocol()}/${this.profileId}.settings`;
  }

  _getSubnetFilePath() {
    return `${f.getHiddenFolder()}/run/docker_vpn_client/${this.constructor.getProtocol()}/${this.profileId}.subnet`;
  }

  async _getRemoteIP() {
    const subnet = await this._getSubnet();
    if (subnet) {
      return Address4.fromBigInteger(new Address4(subnet).bigInteger().add(new BigInteger("2"))).correctForm(); // IPv4 address of gateway in container always uses second address in subnet
    }
    return null;
  }

  async _getSubnet() {
    return await fs.readFileAsync(this._getSubnetFilePath(), {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
  }

  async _getOrGenerateSubnet() {
    let subnet = await fs.readFileAsync(this._getSubnetFilePath(), {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
    if (!subnet) {
      subnet = this._generateRamdomNetwork(); // this returns a /30 subnet
      await fs.writeFileAsync(this._getSubnetFilePath(), subnet, {encoding: "utf8"}).catch((err) => {});
    }
    return subnet;
  }

  async destroy() {
    await super.destroy();
    await fs.unlinkAsync(this._getSettingsPath()).catch((err) => {});
    await fs.unlinkAsync(this._getSubnetFilePath()).catch((err) => {});
    await exec(`rm -rf ${this._getConfigDirectory()}`).catch((err) => {
      log.error(`Failed to remove config directory ${this._getConfigDirectory()}`, err.message);
    });
    await exec(`rm -rf ${this._getWorkingDirectory()}`).catch((err) => {
      log.error(`Failed to remove working directory ${this._getWorkingDirectory()}`, err.message);
    });
  }

  async getVpnIP4s() {
    const subnet = await this._getSubnet();
    if (subnet)
      return Address4.fromBigInteger(new Address4(subnet).bigInteger().add(new BigInteger("1"))).correctForm(); // bridge ipv4 address always uses first address in subnet
  }

  _generateRamdomNetwork() {
    const ipRangeRandomMap = {
      "10.0.0.0/8": 22,
      "172.16.0.0/12": 18,
      "192.168.0.0/16": 14
    };
    let index = 0;
    while (true) {
      index = index % 3;
      const startAddress = Object.keys(ipRangeRandomMap)[index]
      const randomBits = ipRangeRandomMap[startAddress];
      const randomOffsets = Math.floor(Math.random() * Math.pow(2, randomBits)) * 4; // align with 2-bit, i.e., /30
      const subnet = Address4.fromBigInteger(new Address4(startAddress).bigInteger().add(new BigInteger(randomOffsets.toString()))).correctForm();
      if (!sysManager.inMySubnets4(subnet))
        return subnet + "/30";
      else
        index++;
    }
  }

  async _createNetwork() {
    // sudo docker network create -o "com.docker.network.bridge.name"="vpn_sslx" --subnet 10.53.204.108/30 vpn_sslx
    try {
      const subnet = await this._getOrGenerateSubnet();
      const cmd = `sudo docker network inspect ${this._getDockerNetworkName()} &> /dev/null || sudo docker network create -o "com.docker.network.bridge.name"="${this.getInterfaceName()}" --subnet ${subnet} ${this._getDockerNetworkName()}`;
      await exec(cmd);
    } catch(err) {
      log.error(`Got error when creating network ${this._getDockerNetworkName()} for ${this.profileId}, err:`, err.message);
    }
  }

  async _removeNetwork() {
    try {
      const cmd = `sudo docker network rm ${this._getDockerNetworkName()}`;
      await exec(cmd);
    } catch(err) {
      log.error(`Got error when rm network ${this._getDockerNetworkName()} for ${this.profileId}, err:`, err.message);
    }
  }

  _getDockerNetworkName() {
    return `n_${this.getInterfaceName()}`;
  }

  async _updateComposeYAML() {
    // update docker-compose.yaml in working directory, main purpose is to generate randomized subnet for docker bridge network
    const composeFilePath = this._getWorkingDirectory() + "/docker-compose.yaml";
    const config = await fs.readFileAsync(composeFilePath, {encoding: "utf8"}).then(content => YAML.parse(content)).catch((err) => {
      log.error(`Failed to read docker-compose.yaml from ${composeFilePath}`, err.message);
      return;
    });

    // update network config
    if (!config) {
      log.error("docker compose template file not found")
      return;
    }

    config.networks = {};
    config.networks[this._getDockerNetworkName()] = {external: true};

    const serviceNames = Object.keys(config.services);
    if(!_.isEmpty(serviceNames) && serviceNames.length === 1) {
      const serviceName = serviceNames[0];
      const service = config.services[serviceName];
      service.networks = {};
      service.networks[this._getDockerNetworkName()] = {
        "ipv4_address": await this._getRemoteIP()
      }

      service["container_name"] = this.getInterfaceName();

      // do not automatically restart container
      // set restart to "no" will cause docker compose yml parsing error
      //     "restart contains an invalid type, it should be a string"
      if(service["restart"]) delete service["restart"];

      await fs.writeFileAsync(composeFilePath, YAML.stringify(config), {encoding: "utf8"});

    } else {
      log.error("docker compose should only contain one service")
    }
  }

  async _start() {
    await this.__prepareAssets();
    await exec(`mkdir -p ${this._getWorkingDirectory()}`);
    await exec(`cp -f -r ${this._getConfigDirectory()}/* ${this._getWorkingDirectory()}`);
    await this._createNetwork();
    await this._updateComposeYAML();
    await exec(`sudo systemctl start docker-compose@${this.profileId}`);
    const remoteIP = await this._getRemoteIP();
    if (remoteIP)
      await exec(wrapIptables(`sudo iptables -w -t nat -A FW_POSTROUTING -s ${remoteIP} -j MASQUERADE`));
    let t = 0;
    while (t < 30) {
      const carrier = await fs.readFileAsync(`/sys/class/net/${this.getInterfaceName()}/carrier`, {encoding: "utf8"}).then(content => content.trim()).catch((err) => null);
      if (carrier === "1") {
        const remoteIP = await this._getRemoteIP();
        if (remoteIP) {
          // add the container IP to wan_routable so that packets from wan interfaces can be routed to the container
          await routing.addRouteToTable(remoteIP, null, this.getInterfaceName(), "wan_routable", 1024, 4);
        }
        break;
      }
      t++;
      await scheduler.delay(1000);
    }
  }

  async _stop() {
    const remoteIP = await this._getRemoteIP();
    if (remoteIP)
      await exec(wrapIptables(`sudo iptables -w -t nat -D FW_POSTROUTING -s ${remoteIP} -j MASQUERADE`)).catch((err) => {});
    await exec(`sudo systemctl stop docker-compose@${this.profileId}`);
    await this._removeNetwork();
  }

  async getRoutedSubnets() {
    const isLinkUp = await this._isLinkUp();
    if (isLinkUp) {
      const results = [];
      // no need to add the whole subnet to the routed subnets, only need to route the container's IP address
      const remoteIP = await this._getRemoteIP();
      if (remoteIP)
        results.push(remoteIP);
      return results;
    } else {
      return [];
    }
  }

  _getWorkingDirectory() {
    return `${f.getHiddenFolder()}/run/docker/${this.profileId}`;
  }

  _getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/docker_vpn_client/${this.constructor.getProtocol()}/${this.profileId}`;
  }

  getUserConfigPath() {
    return `${this._getConfigDirectory()}/user_config.json`;
  }

  async saveOriginUserConfig(config) {
    const file = this.getUserConfigPath();
    log.info(`[${this.profileId}] Saving user origin config to ${file}...`);
    await fs.writeFileAsync(file, JSON.stringify(config));
  }

  async loadOriginUserConfig() {
    log.info(`[${this.profileId}] Loading user origin config...`);
    try {
      const file = this.getUserConfigPath();
      const raw = await fs.readFileAsync(file, {encoding: 'utf8'});
      return JSON.parse(raw);
    } catch (err) {
      log.error("Got error when loading user config, err:", err);
      return {};
    }
  }

  async checkAndSaveProfile(value) {
    const protocol = this.constructor.getProtocol();
    const config = value[protocol] || {};

    log.info(`[${this.profileId}][${protocol}] saving user config file...`);

    await exec(`mkdir -p ${this._getConfigDirectory()}`);
    await this.saveOriginUserConfig(config);
  }

  async _isLinkUp() {
    const serviceUp = await exec(`sudo docker container ls -f "name=${this.getInterfaceName()}" --format "{{.Status}}"`).then(result => result.stdout.trim().startsWith("Up ")).catch((err) => {
      log.error(`Failed to run docker container ls on ${this.profileId}`, err.message);
      return false;
    });
    if (serviceUp)
      return this.__isLinkUpInsideContainer().catch(() => false);
    else
      return false;
  }

  async getAttributes(includeContent = false) {
    const attributes = await super.getAttributes();

    const userConfig = await this.loadOriginUserConfig();

    attributes.config = userConfig;
    attributes.type = this.constructor.getProtocol();
    return attributes;
  }

  // this needs to be implemented by child class
  async __isLinkUpInsideContainer() {
    return true;
  }

  // docker-based vpn client need to implement this function to fetch files and put them to config directory, e.g., docker-compose.yaml, corresponding files/directories to be mapped as volumes,
  // they will be put in the same directory so relative path can still be used in docker-compose
  async __prepareAssets() {

  }

  // this needs to be implemented by child class
  async _getDNSServers() {
    
  }

  // this needs to be implemented by child class
  static getProtocol() {
    
  }
}

module.exports = DockerBaseVPNClient;
