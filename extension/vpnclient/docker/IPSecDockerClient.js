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
const _ = require('lodash');
const f = require('../../../net2/Firewalla.js');
const PATH = require('path');

class IPSecDockerClient extends DockerBaseVPNClient {

  async _getDNSServers() {
    const config = await this.loadJSONConfig().catch((err) => null);
    if (config && _.isArray(config.dns) && !_.isEmpty(config.dns))
      return config.dns;
    return ["1.1.1.1"];
  }

  async getRoutedSubnets() {
    return [];
  }

  _getFilesDir() {
    return `${this.constructor.getConfigDirectory()}/${this.profileId}/files`;
  }

  async checkAndSaveProfile(value) {
    await super.checkAndSaveProfile(value);
    const files = value.files || [];
    // copy the file content to the same relative path under docker config directory, which will be mapped as volume into container
    await exec(`sudo rm -rf ${this._getFilesDir()}`).catch((err) => {});
    for (const file of files) {
      const path = file.path;
      const content = file.content;
      const permission = file.permission || "644";
      const filename = `${this._getFilesDir()}/${path}`;
      const dirname = PATH.dirname(filename);
      const basename = PATH.basename(filename);
      await fs.mkdirAsync(dirname, {recursive: true, mode: 0o755});
      await fs.writeFileAsync(`${dirname}/${basename}`, content, {encoding: "utf8"});
      await exec(`chmod ${permission} ${dirname}/${basename}`);
    }
  }

  async isSNATNeeded() {
    const config = await this.loadJSONConfig();
    if (_.isEmpty(config))
      return true;
    if (config.hasOwnProperty("snatNeeded"))
      return config["snatNeeded"];
    switch (config.type) {
      case "ikev2-p12":
      case "ikev2-userpasscert":
        return true;
      case "ikev2-generic":
        return false;
      default:
        return true;
    }
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    const composeObj = {
      version: "3",
      services: {
        vpn: {
          privileged: true,
          cap_add: [
            "NET_ADMIN"
          ]
        }
      }
    };

    // default is p12 certificate
    const type = config.type || "ikev2-p12";
    switch(type) {
      case "ikev2-p12":
        await this.prepareP12(config);
        composeObj.services.vpn.image = `public.ecr.aws/a0j1s2e9/strongswan-client:${f.isDevelopmentVersion() ? "dev" : "latest"}`;
        composeObj.services.vpn.volumes = ["./:/data", "./out:/output"];
        break;
      case "ikev2-userpasscert":
        await this.prepareUserPassCert(config);
        composeObj.services.vpn.image = `public.ecr.aws/a0j1s2e9/strongswan-client:${f.isDevelopmentVersion() ? "dev" : "latest"}`;
        composeObj.services.vpn.volumes = ["./:/data", "./out:/output"];
      case "ikev2-generic":
        // classic ipsec.conf ipsec.secrets and other dependent scripts/certificates if necessary
        composeObj.services.vpn.image = `public.ecr.aws/a0j1s2e9/strongswan-clientv2:${f.isDevelopmentVersion() ? "dev" : "latest"}`;
        // add files under ${this._getDockerConfigDirectory()}/files into volumes
        await exec(`sudo rm -rf ${this._getDockerConfigDirectory()}/files`).catch((err) => {});
        await exec(`cp -rf ${this._getFilesDir()} ${this._getDockerConfigDirectory()}`).catch((err) => {
          log.error(`Failed to copy files to ${this._getDockerConfigDirectory()}`, err.message);
        });
        const files = await exec(`find ${this._getDockerConfigDirectory()}/files -type f`).then(result => result.stdout.trim().split('\n').map(line => line.substring(`${this._getDockerConfigDirectory()}/files/`.length)));
        composeObj.services.vpn.volumes = files.map(file => `./files/${file}:/${file}`); // map relative path to the absolute path in container
        break;
    }
    await this._prepareDockerCompose(composeObj);
  }

  async prepareP12(config) {
    const envConfig = `
FW_TYPE="ikev2-p12"
FW_PASSWORD="${config.password}"
FW_IDENTITY="${config.identity}"
FW_SERVER="${config.server}"`;

    const filename = "env";
    log.info(`Preparing ${filename} file for ${this.profileId}...`);
    const dst = `${this._getDockerConfigDirectory()}/${filename}`;
    await fs.writeFileAsync(dst, envConfig);
    await this._prepareBase64File(config, "client.p12", "client.p12");
  }

  async prepareUserPassCert(config) {
    const envConfig = `
FW_TYPE="ikev2-userpasscert"
FW_PASSWORD="${config.password}"
FW_IDENTITY="${config.identity}"
FW_SERVER="${config.server}"`;

    const filename = "env";
    log.info(`Preparing ${filename} file for ${this.profileId}...`);
    const dst = `${this._getDockerConfigDirectory()}/${filename}`;
    await fs.writeFileAsync(dst, envConfig);

    await this._prepareFile(config, "cert", "cert");
  }

  async __isLinkUpInsideContainer() {
    const result = await exec(`sudo docker exec ${this.getContainerName()} ipsec status`).then(output => output.stdout.trim()).catch((err) => {
      log.error(`Failed to check ipsec status on ${this.profileId}`, err.message);
      return null;
    });
    if (!result)
      return false;
    const regexp = /Security Associations \(\d+ up, \d+ connecting\)/;
    const matches = result.match(regexp);
    if (!_.isEmpty(matches)) {
      const match = matches[0];
      const upNumber = match.split(" ")[2].substring(1);
      if (!isNaN(upNumber) && Number(upNumber) > 0)
        return true;
    }
    return false;
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

  async _prepareFile(config = {}, key, filename) {
    log.info(`Preparing file ${filename} for ${this.profileId}...`);
    const dst = `${this._getDockerConfigDirectory()}/${filename}`;
    await fs.writeFileAsync(dst, config[key], {encoding: 'utf8'});
  }

  async getStatistics() {
    const config = await this.loadJSONConfig().catch((err) => null) || {};
    switch (config.type) {
      case "ikev2-generic": {
        const result = await exec(`sudo docker exec ${this.getContainerName()} ipsec statusall`).then(output => output.stdout.trim()).catch((err) => {
          log.error(`Failed to check ipsec statusall on ${this.profileId}`, err.message);
          return null;
        });
        if (!result)
          return {bytesIn: 0, bytesOut: 0};
        let rxBytes = 0;
        let txBytes = 0;
        const regexp = /\d+ bytes_i, \d+ bytes_o/g;
        const matches = result.match(regexp);
        if (!_.isEmpty(matches)) {
          for (const match of matches) {
            const words = match.split(" ");
            rxBytes += Number(words[0]);
            txBytes += Number(words[2]);
          }
        }
        return {bytesIn: rxBytes, bytesOut: txBytes};
        break;
      }
      default:
        return super.getStatistics();
    }
  }

  async destroy() {
    await super.destroy();
    await exec(`sudo rm -rf ${this.constructor.getConfigDirectory()}/${this.profileId}`).catch((err) => {});
  }

}

module.exports = IPSecDockerClient;
