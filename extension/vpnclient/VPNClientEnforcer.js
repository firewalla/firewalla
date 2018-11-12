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
const cp = require('child_process');
const util = require('util');
const routing = require('../routing/routing.js');
const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();

const execAsync = util.promisify(cp.exec);
var instance = null;

const VPN_CLIENT_RULE_TABLE = "vpn_client";
const VPN_CLIENT_RULE_TABLE_ID = 101;

class VPNClientEnforcer {
  constructor() {
    if (instance == null) {
      instance = this;
    }
    this.enabledHosts = {};
    if (process.title === "FireMain") {
      setInterval(() => {
        try {
          log.info("Check and refresh routing rule for VPN client...");
          this._periodicalRefreshRule();
        } catch (err) {
          log.error("Failed to refresh routing rule for VPN client: ", err);
        }
      }, 300 * 1000); // once every 5 minutes
    }
    return instance;
  }

  async enableVPNAccess(mac, mode) {
    if (!this.enabledHosts[mac]) {
      const host = await hostTool.getMACEntry(mac);
      host.vpnClientMode = mode;
      this.enabledHosts[mac] = host;
      switch (mode) {
        case "dhcp":
          const mode = require('../../net2/Mode.js');
          await mode.reloadSetupMode();
          if (mode.isDHCPModeOn()) {
            if (host.ipv4Addr) {
              try {
                await routing.removePolicyRoutingRule(host.ipv4Addr, VPN_CLIENT_RULE_TABLE);
              } catch (err) {
                log.error("Failed to remove policy routing rule for " + host.ipv4Addr, err);
              }
            }
            if (host.spoofing === "true") {
              log.info("Add vpn client routing rule for " + host.ipv4Addr);
              await routing.createPolicyRoutingRule(host.ipv4Addr, VPN_CLIENT_RULE_TABLE);
            }
          } else {
            log.warn(util.format("DHCP mode is not enabled, vpn access of %s is suspended.", mac));
          }
          break;
        default:
          log.error("Unsupported vpn client mode: " + mode);
      }
      
    }
  }

  async disableVPNAccess(mac) {
    if (this.enabledHosts[mac]) {
      const host = this.enabledHosts[mac];
      try {
        await routing.removePolicyRoutingRule(host.ipv4Addr, VPN_CLIENT_RULE_TABLE);
      } catch (err) {
        log.error("Failed to remove policy routing rule for " + host.ipv4Addr, err);
      }
      delete this.enabledHosts[mac];
    }
  }

  async enforceVPNClientRoutes(remoteIP, intf) {
    // ensure customized routing table is created
    await routing.createCustomizedRoutingTable(VPN_CLIENT_RULE_TABLE_ID, VPN_CLIENT_RULE_TABLE);
    // add routes from main routing table to vpn client table except default route
    await routing.flushRoutingTable(VPN_CLIENT_RULE_TABLE);
    let cmd = "ip route list | grep -v default";
    const routes = await execAsync(cmd);
    await Promise.all(routes.stdout.split('\n').map(async route => {
      if (route.length > 0) {
        cmd = util.format("sudo ip route add %s table %s", route, VPN_CLIENT_RULE_TABLE);
        await execAsync(cmd);
      }
    }));
    // then add remote IP as gateway of default route to vpn client table
    await routing.addRouteToTable("default", remoteIP, intf, VPN_CLIENT_RULE_TABLE);
  }

  async flushVPNClientRoutes() {
    await routing.flushRoutingTable(VPN_CLIENT_RULE_TABLE);
  }

  async _periodicalRefreshRule() {
    await Promise.all(Object.keys(this.enabledHosts).map(async mac => {
      const host = await hostTool.getMACEntry(mac);
      const oldHost = this.enabledHosts[mac];
      const enabledMode = oldHost.vpnClientMode;
      host.vpnClientMode = enabledMode;
      switch (enabledMode) {
        case "dhcp":
          const mode = require('../../net2/Mode.js');
          await mode.reloadSetupMode();
          if (host.ipv4Addr !== oldHost.ipv4Addr || !mode.isDHCPModeOn() || host.spoofing === "false") {
            // policy routing rule should be removed anyway if ip address is changed or dhcp mode is not enabled
            // or host is not monitored
            try {
              await routing.removePolicyRoutingRule(oldHost.ipv4Addr, VPN_CLIENT_RULE_TABLE);
            } catch (err) {
              log.error("Failed to remove policy routing rule for " + host.ipv4Addr, err);
            }
          }
          if (mode.isDHCPModeOn() && host.spoofing === "true") {
            await routing.createPolicyRoutingRule(host.ipv4Addr, VPN_CLIENT_RULE_TABLE);
          }
          this.enabledHosts[mac] = host;
          break;
        default:
          log.error("Unsupported vpn client mode: " + mode);
      }
    }));
  }
}

module.exports = VPNClientEnforcer;