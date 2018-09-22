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

const log = require('../net2/logger.js')(__filename);
const cp = require('child_process');
const util = require('util');
const routing = require('../routing/routing.js');
const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();

const execAsync = util.promisify(cp.exec);
var instance = null;

const VPN_CLIENT_RULE_TABLE = "vpn_client";

class VPNClientEnforcer {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    this.enabledHosts = {};
    setInterval(() => {
      try {
        log.info("Check and refresh routing rule for VPN client...");
        this._periodicalRefreshRule();
      } catch (err) {
        log.error("Failed to refresh routing rule for VPN client: ", err);
      }
    }, 300 * 1000); // once every 5 minutes
    return instance;
  }

  async enableVPNAccess(mac) {
    if (!this.enabledHosts[mac]) {
      const host = await hostTool.getMACEntry(mac);
      this.enabledHosts.mac = host;
      if (host.ipv4Addr) {
        await routing.createPolicyRoutingRule(host.ipv4Addr, VPN_CLIENT_RULE_TABLE);
      }
    }
  }

  async disableVPNAccess(mac) {
    if (this.enabledHosts[mac]) {
      const host = this.enabledHosts[mac];
      await routing.removePolicyRoutingRule(host.ipv4Addr, VPN_CLIENT_RULE_TABLE);
      delete this.enabledHosts[mac];
    }
  }

  async enforceVPNClientRoutes(remoteIP, intf) {
    // add routes from main routing table to vpn client table except default route
    let cmd = "ip route list | grep -v default";
    const routes = await execAsync(cmd);
    routes.split('\n').forEach((route) => {
      cmd = util.format("sudo ip route add %s table %s", route, VPN_CLIENT_RULE_TABLE);
      await execAsync(cmd);
    });
    // then add remote IP as gateway of default route to vpn client table
    cmd = util.format("sudo ip route add default via %s dev %s table %s", remoteIP, intf, VPN_CLIENT_RULE_TABLE);
    await execAsync(cmd);
  }

  async flushVPNClientRoutes() {
    await routing.flushRoutingTable(VPN_CLIENT_RULE_TABLE);
  }

  async _periodicalRefreshRule() {
    Object.keys(this.enabledHosts).forEach((mac) => {
      const host = await hostTool.getMACEntry(mac);
      const oldHost = this.enabledHosts[mac];
      if (host.ipv4Addr !== oldHost.ipv4Addr) {
        // need to refresh corresponding ip rule
        await routing.removePolicyRoutingRule(oldhost.ipv4Addr, VPN_CLIENT_RULE_TABLE);
        await routing.createPolicyRoutingRule(host.ipv4Addr, VPN_CLIENT_RULE_TABLE);
        this.enabledHosts.mac = host;
      }
    });
  }
}

module.exports = VPNClientEnforcer;