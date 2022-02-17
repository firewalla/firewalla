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
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const DockerBaseVPNClient = require('./DockerBaseVPNClient.js');
const YAML = require('../../../vendor_lib/yaml/dist');
const _ = require('lodash');
const f = require('../../../net2/Firewalla.js');

const envFilename = "zerotier-client.env";

const yamlJson = {
  "version": "3",
  "services": {
    "zerotier-client": {
      "image": "zerotier/zerotier",
      "networks": [
        "default"
      ],
      "cap_add": [
        "NET_ADMIN"
      ],
      "devices": [
        "/dev/net/tun"
      ],
      "env_file": [
        envFilename
      ]
    }
  },
  "networks": {
    "default": {
    }
  }
}

class ZTDockerClient extends DockerBaseVPNClient {

  async checkAndSaveProfile(value) {
    await exec(`mkdir -p ${this._getDockerConfigDirectory()}`);
    const config = value && value.config;
    const networkId = config && config.networkId;
    if (!networkId)
      throw new Error("networkId is not specified");
    await this.saveJSONConfig(config);
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig().catch((err) => {
      log.error(`Failed to read config of zerotier client ${this.profileId}`, err.message);
      return null;
    });
    if (!config)
      return;
    yamlJson.services["zerotier-client"].command = [config.networkId];
    await fs.writeFileAsync(`${this._getDockerConfigDirectory()}/docker-compose.yaml`, YAML.stringify(yamlJson), {encoding: "utf8"});
    const envs = [];
    if (config.identityPublic)
      envs.push(`ZEROTIER_IDENTITY_PUBLIC=${config.identityPublic}`);
    if (config.identitySecret)
      envs.push(`ZEROTIER_IDENTITY_SECRET=${config.identitySecret}`);
    if (envs.length > 0)
      await fs.writeFileAsync(`${this._getDockerConfigDirectory()}/${envFilename}`, envs.join('\n'), {encoding: "utf8"});
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/zerotier_profile`;
  }

  static getProtocol() {
    return "zerotier";
  }

  static getKeyNameForInit() {
    return "ztvpnClientProfiles";
  }

  async __isLinkUpInsideContainer() {
    const config = await this.loadJSONConfig().catch((err) => {
      log.error(`Failed to read config of zerotier client ${this.profileId}`, err.message);
      return null;
    });
    if (!config)
      return false;
    const resultJson = await exec(`sudo docker exec vpn_hahaha zerotier-cli listnetworks -j`).then(result => JSON.parse(result.stdout.trim())).catch((err) => {
      log.error(`Failed to run zerotier-cli listnetworks inside container of ${this.profileId}`, err.message);
      return null;
    });
    if (resultJson && _.isArray(resultJson)) {
      const network = resultJson.find(r => r.nwid === config.networkId);
      return network && network.status === "OK" || false;
    } else {
      return false;
    }
  }
}

module.exports = ZTDockerClient;
