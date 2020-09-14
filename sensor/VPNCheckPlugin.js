/*    Copyright 2019 Firewalla LLC
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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const extensionManager = require('./ExtensionManager.js')

const rp = require('request-promise');

const config = require('../net2/config.js').getConfig();
const exec = require('child-process-promise').exec;

const rclient = require('../util/redis_manager.js').getRedisClient();

const api = config.firewallaVPNCheckURL || "https://api.firewalla.com/diag/api/v1/vpn/check_portmapping";
const pl = require('../platform/PlatformLoader.js');
const platform = pl.getPlatform();
class VPNCheckPlugin extends Sensor {

  async apiRun() {
    extensionManager.onCmd("vpn_port_forwarding_check", async (msg, data) => {
      const checkResult = await this.check();

      if(checkResult === null) {
        return {result: "unknown"};
      } else {
        return {result: checkResult};
      }
    });
  }

  async getTLSAuthKey() {
    const cmd = "sudo cat /etc/openvpn/easy-rsa/keys/ta.key";
    try {
      const result = await exec(cmd);
      if(result.stdout) {
        return result.stdout;
      } else {
        return null;
      }
    } catch(err) {
      log.error("Failed to get ta key:", err);
      return null;
    }
  }

  async check() {
    const taKey = await this.getTLSAuthKey();
    if(!taKey) {
      return null;
    }

    const token = await rclient.hgetAsync("sys:ept", "token");
    if(!token) {
      return null;
    }
    let protocol;
    let port;
    let vpnConfig = await rclient.hgetAsync("policy:system","vpn");
    try{
      vpnConfig = JSON.parse(vpnConfig) || {};
      protocol = vpnConfig.protocol;
      port = Number(vpnConfig.externalPort || 1194);
    }catch(e){}
    protocol = protocol? protocol : platform.getVPNServerDefaultProtocol();
    const option = {
      method: "POST",
      uri: api,
      json: {
        tls_auth: taKey,
        protocol: protocol,
        port: port
      },
      auth: {
        bearer: token
      }
    }

    try {
      const responseBody = await rp(option);

      if(!responseBody) {
        return null;
      }

      if(responseBody.result) {
        return true;
      } else {
        return false;
      }
    } catch(err) {
      log.error("Failed to check vpn port forwarding:", err);
      return null;
    }
  }
}

module.exports = VPNCheckPlugin
