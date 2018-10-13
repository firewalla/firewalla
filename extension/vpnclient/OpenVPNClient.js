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
const SERVICE_FILE = `${__dirname}/${SERVICE_NAME}@.service`;

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
    const profileId = options["profileId"];
    if (!profileId)
      throw "profileId is not set";
    this.profileId = profileId;
    const ovpnPath = this._getProfilePath(profileId);
    if (fs.existsSync(ovpnPath)) {
      this.ovpnPath = ovpnPath;
      await this._reviseProfile(this.ovpnPath);
    } else throw util.format("ovpn file %s is not found", ovpnPath);
    const passwordPath = this._getPasswordPath(profileId);
    if (!fs.existsSync(passwordPath)) {
      // create dummy password file, otherwise openvpn will report missing file on --askpass option
      await writeFileAsync(passwordPath, "dummy_ovpn_password", 'utf8');
    }
  }

  _getProfilePath(profileId) {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + profileId + ".ovpn";
    return path;
  }

  _getPasswordPath(profileId) {
    const path = f.getHiddenFolder() + "/run/ovpn_profile/" + profileId + ".password";
    return path;
  }

  async _reviseProfile(ovpnPath) {
    const cmd = "openvpn --version | head -n 1 | awk '{print $2}'";
    const result = await execAsync(cmd);
    const version = result.stdout;
    let content = await readFileAsync(ovpnPath, 'utf8');
    let revisedContent = content;
    if (version.startsWith("2.3.")) {
      const lines = content.split("\n");
      lines.forEach((line) => {
        const options = line.split(/\s+/);
        const option = options[0];
        switch (option) {
          case "compress":
            // OpenVPN 2.3.x does not support 'compress' option
            if (options.length > 1) {
              const algorithm = options[1];
              if (algorithm !== "lzo") {
                throw util.format("Unsupported compress algorithm for OpenVPN 2.3: %s", algorithm);
              } else {
                revisedContent = revisedContent.replace(/compress\s+lzo/g, "comp-lzo");
              }
            } else {
              // turn off compression, set 'comp-lzo' to no
              revisedContent = revisedContent.replace(/compress/g, "comp-lzo no");
            }
            break;
          default:
        }
      })
    }
    if (version.startsWith("2.4.")) {
      // 'comp-lzo' is deprecated in 2.4.x
      revisedContent = revisedContent.replace(/comp\-lzo/g, "compress lzo");
    }
    await writeFileAsync(ovpnPath, revisedContent, 'utf8');
  }

  async start() {
    if (!this.profileId) {
      throw "OpenVPN client is not setup properly. Profile id is missing."
    }
    let cmd = util.format("sudo systemctl start %s@%s", SERVICE_NAME, this.profileId);
    await execAsync(cmd);
    // remove two routes from main table which is inserted by OpenVPN client automatically,
    // otherwise tunnel will be enabled globally
    cmd = "sleep 10";
    await execAsync(cmd);
    const remoteIP = await this.getRemoteIP();
    const intf = await this.getInterfaceName();
    if (remoteIP !== null && remoteIP !== "" && intf !== null && intf !== "") {
      try {
        await routing.removeRouteFromTable("0.0.0.0/1", remoteIP, intf, "main");
        await routing.removeRouteFromTable("128.0.0.0/1", remoteIP, intf, "main");
      } catch (err) {
        // these routes may not exist depending on server config
        log.error("Failed to remove default vpn client route", err);
      }
      return true;
    } else {
      log.error("Failed to establish tunnel for OpenVPN client, stop it...");
      return false;
    }
  }

  async _isTunEstablished() {
    const remoteIP = await this.getRemoteIP();
    const intf = await this.getInterfaceName();
    if (remoteIP !== null && remoteIP !== "" && intf !== null && intf !== "") {
      return true;
    } else return false;
  }

  async stop() {
    let cmd = util.format("sudo systemctl stop %s@%s", SERVICE_NAME, this.profileId);
    await execAsync(cmd);
    cmd = util.format("sudo systemctl disable %s@%s", SERVICE_NAME, this.profileId);
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