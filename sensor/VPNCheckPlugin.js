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
const fallbackSTUNServers = ["stun1.l.google.com:19302", "stun2.l.google.com:19302", "stun3.l.google.com:19302"];
const stunTestLocalPort = 55555;
const _ = require('lodash');
const dgram = require('dgram');
const NAT_TYPE_OPEN = "nat::open";
const NAT_TYPE_FULL_CONE = "nat::full_cone";
const NAT_TYPE_SYMMETRIC = "nat::symmetric";
const NAT_TYPE_UNKNOWN = "nat::unknown";

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
    const localIP = this.getLocalIP();
    if (localIP)
      option["localAddress"] = localIP;
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

  async checkNATType() {
    // use public STUN servers to check NAT types
    // send UDP packets to different STUN servers from the same local IP and port. If different NAT servers returns different public IP and port combination, it is symmetric NAT, otherwise full cone NAT
    // FIXME: this is insufficient to determine full cone NAT. Ubuntu Linux will use the same external port for oubound UDP connections to different remote IPs though we know it is symmetric NAT.
    let stunServers = this.config.stunServers;
    if (_.isEmpty(stunServers))
      stunServers = fallbackSTUNServers;
    const socket = dgram.createSocket({
      type: "udp4"
    });
    const localIP = sysManager.myDefaultWanIp();
    if (localIP)
      socket.bind(stunTestLocalPort, localIP);
    else
      socket.bind(stunTestLocalPort);
    const resultMap = {};
    socket.on('error', (err) => {
      log.error(`STUN socket error`, err.emssage);
    });
    socket.on('message', async (message, info) => {
      const serverIp = info.address;
      const length = message.length;
      const portOffset = length - 6;
      const ipOffset = length - 4;
      const port = message.readUInt16BE(portOffset);
      const addr = `${message.readUInt8(ipOffset)}.${message.readUInt8(ipOffset + 1)}.${message.readUInt8(ipOffset + 2)}.${message.readUInt8(ipOffset + 3)}`;
      resultMap[serverIp] = `${addr}:${port}`;
    });
    const buffer = Buffer.from("\x00\x01\x00\x00YOGO\x59\x4f\x47\x4fSTACFLOW");
    for (const server of stunServers) {
      const [host, port] = server.split(':');
      socket.send(buffer, port, host);
    }
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        socket.close();
        log.info("Result from STUN servers", resultMap);
        if (Object.keys(resultMap) <= 1)
          resolve(NAT_TYPE_UNKNOWN);
        else {
          const set = new Set(Object.values(resultMap));
          if (set.size == 1) {
            if (Object.values(resultMap)[0] === `${localIP}:${stunTestLocalPort}`)
              resolve(NAT_TYPE_OPEN);
            else
              resolve(NAT_TYPE_FULL_CONE);
          } else
            resolve(NAT_TYPE_SYMMETRIC);
        }
      }, 3000);
    })
  }

  getLocalIP() {
    if (sysManager.publicIp && sysManager.publicIps) {
      if (sysManager.isMyIP(sysManager.publicIp))
        return sysManager.publicIp;
      const wanIntfName = Object.keys(sysManager.publicIps).find(i => sysManager.publicIps[i] === sysManager.publicIp);
      if (wanIntfName) {
        const intf = sysManager.getInterface(wanIntfName);
        if (intf.type === "wan" && intf.ip_address)
          return intf.ip_address;
      }
    }
    return null;
  }
}

module.exports = VPNCheckPlugin
