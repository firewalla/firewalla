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
const spawn = require('child-process-promise').spawn;
const rclient = require('../util/redis_manager.js').getRedisClient();
const delay = require('../util/util.js').delay;
const api = config.firewallaVPNCheckURL || "https://api.firewalla.com/diag/api/v1/vpn/check_portmapping";
const pl = require('../platform/PlatformLoader.js');
const platform = pl.getPlatform();
const sysManager = require('../net2/SysManager.js');

class VPNCheckPlugin extends Sensor {

  async apiRun() {
    extensionManager.onCmd("vpn_port_forwarding_check", async (msg, data) => {
      const checkResult = await this.check(data);

      if (checkResult === null) {
        return { result: "unknown" };
      } else {
        return { result: checkResult };
      }
    });
  }

  async getTLSAuthKey() {
    const cmd = "sudo cat /etc/openvpn/easy-rsa/keys/ta.key";
    try {
      const result = await exec(cmd);
      if (result.stdout) {
        return result.stdout;
      } else {
        return null;
      }
    } catch (err) {
      log.error("Failed to get ta key:", err);
      return null;
    }
  }

  async generateData(data) {
    let { type = 'openvpn', protocol, port } = data;
    const taKey = await this.getTLSAuthKey();
    if (!taKey) {
      return null;
    }
    const token = await rclient.hgetAsync("sys:ept", "token");
    if (!token) {
      return null;
    }
    if (type == 'openvpn') {
      let vpnConfig = await rclient.hgetAsync("policy:system", "vpn");
      try {
        vpnConfig = JSON.parse(vpnConfig) || {};
        protocol = vpnConfig.protocol;
        port = Number(vpnConfig.externalPort || 1194);
      } catch (e) { }
      protocol = protocol ? protocol : platform.getVPNServerDefaultProtocol();
    }
    const option = {
      method: "POST",
      uri: api,
      json: {
        tls_auth: taKey,
        protocol: protocol,
        port: port,
        type: type
      },
      auth: {
        bearer: token
      }
    }
    return { option, type, protocol, port }
  }

  async check(data = {}) {
    const dataMap = await this.generateData(data);
    if (!dataMap) return null;
    const { option, type, port } = dataMap;
    let cloud_check_result = null, conntrack_check_result = null, conntrack_check_done = false;
    let conntrackCP;
    if (type == 'wireguard') {
      try {
        conntrackCP = spawn('sudo', ['timeout', '10s', 'conntrack', '-E', '-p', 'udp', `--dport=${port}`, '-e', 'NEW']);
        conntrackCP.catch((err) => { }); // killed by timeout
        const conntrack = conntrackCP.childProcess;
        conntrack.stdout.on('data', (data) => {
          log.info(`Found connection to ${port}`, data.toString());
          conntrack_check_result = true;
        })
        conntrack.stderr.on('data', (data) => { });
        conntrack.on('close', (code) => { conntrack_check_done = true; });
      } catch (e) {
        conntrack_check_done = true;
        conntrack_check_result = false;
      }
    }
    if (sysManager.publicIp && sysManager.publicIps) {
      const wanIntfName = Object.keys(sysManager.publicIps).find(i => sysManager.publicIps[i] === sysManager.publicIp);
      if (wanIntfName) {
        const intf = sysManager.getInterface(wanIntfName);
        if (intf.type === "wan" && intf.ip_address)
          option["localAddress"] = intf.ip_address;
      }
    }
    try {
      const responseBody = await rp(option);
      if (!responseBody) {
        cloud_check_result = null;
      }
      if (responseBody.result) {
        cloud_check_result = true;
      } else {
        cloud_check_result = false;
      }
    } catch (err) {
      log.error("Failed to check vpn port forwarding:", err);
      cloud_check_result = null;
    }
    if (type == 'wireguard') {
      while (!conntrack_check_result && !conntrack_check_done) {
        await delay(1 * 1000)
      }
      return conntrack_check_result;
    } else {
      return cloud_check_result;
    }
  }
}

module.exports = VPNCheckPlugin
