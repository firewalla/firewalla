/*    Copyright 2016 Firewalla LLC 
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

const log = require('../../net2/logger.js')(__filename);
const fs = require('fs');
const cp = require('child_process');
const util = require('util');
const f = require('../../net2/Firewalla.js');

var instance = null;

const VPNClient = require('./VPNClient.js');

const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);
const execAsync = util.promisify(cp.exec);

const SERVICE_NAME = "openvpn_client";
const SERVICE_TEMPLATE_FILE = `${__dirname}/openvpn_client.service.template`;
const SERVICE_FILE = `${__dirname}/${SERVICE_NAME}.service`;

const PASSWORD_FILE = f.getUserHome() + "/.vpnclient.password";

const routing = require('../routing/routing.js');

class OpenVPNClient extends VPNClient {
  constructor() {
    super();
    if (instance == null) {
      instance = this;
    }
    return instance;
  }

  async setup(options) {
    const ovpnPath = options["ovpnPath"];
    const password = options["password"]; // password is optional
    if (!ovpnPath)
      throw "ovpnPath is not set";
    if (fs.existsSync(ovpnPath)) {
      this.ovpnPath = ovpnPath;
    } else throw util.format("ovpn file %s is not found", ovpnPath);
    if (password) {
      // update password in file if required
      const cmd = util.format("echo %s > %s", password, PASSWORD_FILE);
      await execAsync(cmd);
    }
  }

  async start() {
    if (!this.ovpnPath) {
      throw "OpenVPN client is not setup properly."
    }
    let template = await readFileAsync(SERVICE_TEMPLATE_FILE, 'utf8');
    template = template.replace(/OVPN_CLIENT_CONF/g, this.ovpnPath);
    template = template.replace(/OVPN_PASSWORD_FILE/g, PASSWORD_FILE);
    await writeFileAsync(SERVICE_FILE, template, 'utf8');
    let cmd = util.format("sudo cp %s /etc/systemd/system", SERVICE_FILE);
    await execAsync(cmd);
    cmd = util.format("sudo systemctl start %s", SERVICE_NAME);
    await execAsync(cmd);
    // remove two routes from main table which is inserted by OpenVPN client automatically,
    // otherwise tunnel will be enabled globally
    setTimeout(async () => {
      const remoteIP = await this.getRemoteIP();
      const intf = await this.getInterfaceName();
      await routing.removeRouteFromTable("0.0.0.0/1", remoteIP, intf, "main");
      await routing.removeRouteFromTable("128.0.0.0/1", remoteIP, intf, "main");
    }, 10000);
  }

  async stop() {
    let cmd = util.format("sudo systemctl stop %s", SERVICE_NAME);
    await execAsync(cmd);
    cmd = util.format("sudo systemctl disable %s", SERVICE_NAME);
    await execAsync(cmd);
  }

  async getRemoteIP() {
    const cmd = "ifconfig | grep P-t-P | awk '{print $2,$3}'";
    const result = await execAsync(cmd);
    const lines = result.stdout.split('\n');
    for (let i in lines) {
      const line = lines[i];
      if (line.length == 0)
        continue;
      const addrs = line.split(" ");
      const local = addrs[0].split(':')[1];
      const peer = addrs[1].split(':')[1];
      if (local.split('.')[3] !== "1") {
        // this is an address belonging to OpenVPN client
        return peer;
      }
    }
    return null;
  }

  async getInterfaceName() {
    const remoteIP = await this.getRemoteIP();
    const cmd = util.format("ifconfig | grep %s -B 1 | head -n 1 | awk '{print $1}' | tr -d '\n'", remoteIP);
    const result = await execAsync(cmd);
    if (result.stderr !== "") {
      throw result.stderr;
    } else return result.stdout;
  }
}

module.exports = OpenVPNClient;