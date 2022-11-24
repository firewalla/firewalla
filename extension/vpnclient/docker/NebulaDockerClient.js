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
const YAML = require('../../../vendor_lib/yaml');
const Message = require('../../../net2/Message.js');

class NebulaDockerClient extends DockerBaseVPNClient {

  // TBD
  async _getDNSServers() {
    const config = await this.loadJSONConfig().catch((err) => null);
    if (config && _.isArray(config.dns) && !_.isEmpty(config.dns))
      return config.dns;
    return ["1.1.1.1"];
  }

  _getRedisRouteUpdateMessageChannel() {
    return Message.MSG_NEBULA_VPN_ROUTE_UPDATE;
  }

  // Routed Subnets is provided via config
  async getRoutedSubnets() {
    const base = await super.getRoutedSubnets() || [];
    try {
      const config = await this.loadJSONConfig();
      if(config &&
         config.extra &&
         config.extra.tun &&
         config.extra.tun.unsafe_routes) {
        return _.uniq(config.extra.tun.unsafe_routes.map((r) => r.route).concat(base));
      }
    } catch(err) {
      log.error("Got error when getting routed subnets, err", err);
    }

    return base;
  }

  async _prepareConfig(config) {
    const templateFile = `${__dirname}/nebula/config.template.yml`;
    const templateContent = await fs.readFileAsync(templateFile, {encoding: 'utf8'});
    const template = YAML.parse(templateContent);
    if(!template) {
      log.error("No template found:", templateFile);
      return;
    }

    try {
      if(!_.isEmpty(config.extra)) {
        const finalConfig = Object.assign({}, template);
        const extra = config.extra;

        if(finalConfig.tun && extra.tun) {
          finalConfig.tun.unsafe_routes = extra.tun.unsafe_routes;
        }
        if(extra.lighthouse && extra.lighthouse.hosts) {
          finalConfig.lighthouse.hosts = extra.lighthouse.hosts;
        }
        if(extra.static_host_map) {
          finalConfig.static_host_map = extra.static_host_map;
        }

        const dst = `${this._getDockerConfigDirectory()}/config.yml`;
        log.info("Writing final config file", dst);
        await fs.writeFileAsync(dst, YAML.stringify(finalConfig));
      }

      if(config.caCrt) {
        const caCrt = `${this._getDockerConfigDirectory()}/ca.crt`;
        await fs.writeFileAsync(caCrt, config.caCrt);
      }

      if(config.hostCrt) {
        const hostCrt = `${this._getDockerConfigDirectory()}/host.crt`;
        await fs.writeFileAsync(hostCrt, config.hostCrt);
      }

      if(config.hostKey) {
        const hostKey = `${this._getDockerConfigDirectory()}/host.key`;
        await fs.writeFileAsync(hostKey, config.hostKey);
      }

    } catch(err) {
      log.error("Failed to prepare configs, err:", err);
    }
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    if(!config.caCrt || !config.hostCrt || !config.hostKey) {
      log.error("Requiring caCrt, hostCrt, hostKey.");
      return;
    }

    const composeObj = {
      version: "3",
      services: {
        vpn: {
          image: `public.ecr.aws/a0j1s2e9/nebula:${f.isDevelopmentVersion() ? "dev" : "latest"}`,
          cap_add: [
            "NET_ADMIN"
          ],
          volumes: [
            "./:/etc/nebula",
            "/dev/net/tun:/dev/net/tun"
          ]
        }
      }
    };

    await this._prepareDockerCompose(composeObj);
    await this._prepareConfig(config);
  }

  async __isLinkUpInsideContainer() {
    return true;

    const result = await exec(`sudo docker exec ${this.getContainerName()} nebula status`).then(output => output.stdout.trim()).catch((err) => {
      log.error(`Failed to check nebula status on ${this.profileId}`, err.message);
      return null;
    });
    if (!result)
      return false;
    return true;
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/nebula_profile`;
  }

  static getProtocol() {
    return "nebula";
  }

  static getKeyNameForInit() {
    return "nebulavpnClientProfiles";
  }

  getEffectiveInterface() {
    return "nebula1";
  }

  async isSNATNeeded() {
    return false;
  }

}

module.exports = NebulaDockerClient;
