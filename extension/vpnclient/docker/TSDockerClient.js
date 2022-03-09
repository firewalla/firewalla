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
const iptool = require("ip");
const { Address4, Address6 } = require('ip-address');

class TSDockerClient extends DockerBaseVPNClient {

  _getOutputDirectory() {
    return `${f.getHiddenFolder()}/run/docker/${this.profileId}/output`;
  }

  // TBD
  async _getDNSServers() {
    return ["100.100.100.100"];
  }

  async getRoutedSubnets() {
    const result = await exec(`sudo docker exec ${this.getContainerName()} ip r show table 52 | awk '{print $1}'`)
          .then(output => output.stdout.trim())
          .catch((err) => {
      log.error(`Failed to check tailscale status on ${this.profileId}`, err.message);
      return [];
    });
    if (!result)
      return [];

    const subnets = result.split("\n");

    const natGradeSubnet = "100.64.0.0/10";
    const routedSubnets = subnets.filter((subnet) => {
      if(iptool.isV4Format(subnet)) {
        const addr4 = new Address4(subnet);
        const natAddr4 = new Address4(natGradeSubnet);
        if(addr4.isInSubnet(natAddr4)) {
          return false;
        }
      }

      return true;
    });

    return routedSubnets;
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    // TODO: authKey should be provisioned from cloud
    if(_.isEmpty(config.authKey)) return;

    const composeObj = {
      version: "3",
      services: {
        vpn: {
          image: `public.ecr.aws/a0j1s2e9/tailscale:${f.isDevelopmentVersion() ? "dev" : "latest"}`,
          privileged: true,
          cap_add: [
            "NET_ADMIN"
          ],
          volumes: [
            "./data:/var/lib/tailscale"
          ],
          environment: {
            "TAILSCALE_AUTH_KEY": config.authKey,
            "TAILSCALE_ACCEPT_ROUTES": "true",
            "TAILSCALE_LOGIN_SERVER": f.isDevelopmentVersion() ? "https://fwdev.encipher.io:48443" : "https://TBD"
          }
        }
      }
    };

    await this._prepareDockerCompose(composeObj);
  }

  async __isLinkUpInsideContainer() {
    const result = await exec(`sudo docker exec ${this.getContainerName()} tailscale status`).then(output => output.stdout.trim()).catch((err) => {
      log.error(`Failed to check tailscale status on ${this.profileId}`, err.message);
      return null;
    });
    if (!result)
      return false;
    return true;
  }

  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/ts_profile`;
  }

  static getProtocol() {
    return "ts";
  }

  static getKeyNameForInit() {
    return "tsvpnClientProfiles";
  }

  getEffectiveInterface() {
    return "tailscale0";
  }

  async isSNATNeeded() {
    return false;
  }

}

module.exports = TSDockerClient;
