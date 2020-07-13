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
const ipTool = require('ip');
const util = require('util');
const routing = require('../routing/routing.js');

const iptables = require('../../net2/Iptables.js');
const wrapIptables = iptables.wrapIptables;
const ipset = require('../../net2/Ipset.js');
const platformLoader = require('../../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const execAsync = util.promisify(cp.exec);

const VPN_CLIENT_RULE_TABLE_PREFIX = "vpn_client";

class VPNClientEnforcer {
  constructor() {
    return this;
  }

  _getRoutingTableName(vpnIntf) {
    return `${VPN_CLIENT_RULE_TABLE_PREFIX}_${vpnIntf}`;
  }

  async getRtId(vpnIntf) {
    const tableName = this._getRoutingTableName(vpnIntf);
    return await routing.createCustomizedRoutingTable(tableName).catch((err) => null);
  }

  async enforceStrictVPN(vpnIntf) {
    if (!vpnIntf) {
      throw "Interface is not specified";
    }
    const rtId = await this.getRtId(vpnIntf);
    if (!rtId)
      return;
    const rtIdHex = Number(rtId).toString(16);
    const cmd = wrapIptables(`sudo iptables -w -A FW_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff -m set ! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst ! -o ${vpnIntf} -j FW_DROP`);
    await execAsync(cmd).catch((err) => {
      log.error(`Failed to enforce strict vpn on ${vpnIntf}`, err);
    });
  }

  async unenforceStrictVPN(vpnIntf) {
    if (!vpnIntf) {
      throw "Interface is not specified";
    }
    const rtId = await this.getRtId(vpnIntf);
    if (!rtId)
      return;
    const rtIdHex = Number(rtId).toString(16);
    const cmd = wrapIptables(`sudo iptables -w -D FW_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff -m set ! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst ! -o ${vpnIntf} -j FW_DROP`);
    await execAsync(cmd).catch((err) => {
      log.error(`Failed to unenforce strict vpn on ${vpnIntf}`, err);
      throw err;
    });
  }

  async enforceVPNClientRoutes(remoteIP, vpnIntf, routedSubnets = [], overrideDefaultRoute = true) {
    if (!vpnIntf)
      throw "Interface is not specified";
    const tableName = this._getRoutingTableName(vpnIntf);
    // ensure customized routing table is created
    const rtId = await routing.createCustomizedRoutingTable(tableName);
    await routing.flushRoutingTable(tableName);
    // add policy based rule, the priority 6000 is a bit higher than the firerouter's application defined fwmark
    await routing.createPolicyRoutingRule("all", null, tableName, 6000, `${rtId}/0xffff`);
    if (platform.isFireRouterManaged()) {
      // on firerouter-managed platform, no need to copy main routing table to the vpn client routing table
      // but need to grant access to wan_routable table for packets from vpn interface
      await routing.createPolicyRoutingRule("all", vpnIntf, "wan_routable", 5000, null, 4);
    } else {
      // copy all routes from main routing table on non-firerouter-managed platform
      let cmd = "ip route list";
      if (overrideDefaultRoute)
        // do not copy default route from main routing table
        cmd = "ip route list | grep -v default";
      const routes = await execAsync(cmd);
      await Promise.all(routes.stdout.split('\n').map(async route => {
        if (route.length > 0) {
          cmd = util.format("sudo ip route add %s table %s", route, tableName);
          await execAsync(cmd).catch((err) => {}); // this usually happens when multiple function calls are executed simultaneously. It should have no side effect and will be consistent eventually
        }
      }));
    }
    for (let routedSubnet of routedSubnets) {
      const cidr = ipTool.cidrSubnet(routedSubnet);
      // change subnet to ip route acceptable format
      const formattedSubnet = `${cidr.networkAddress}/${cidr.subnetMaskLength}`;
      await routing.addRouteToTable(formattedSubnet, remoteIP, vpnIntf, tableName).catch((err) => {});
    }
    if (overrideDefaultRoute) {
      // then add remote IP as gateway of default route to vpn client table
      await routing.addRouteToTable("default", remoteIP, vpnIntf, tableName).catch((err) => {}); // this usually happens when multiple function calls are executed simultaneously. It should have no side effect and will be consistent eventually
    }
  }

  async flushVPNClientRoutes(vpnIntf) {
    if (!vpnIntf)
      throw "Interface is not specified";
    const tableName = this._getRoutingTableName(vpnIntf);
    const rtId = await routing.createCustomizedRoutingTable(tableName);
    await routing.flushRoutingTable(tableName);
    // remove policy based rule
    await routing.removePolicyRoutingRule("all", null, tableName, 6000, `${rtId}/0xffff`);
    await routing.removePolicyRoutingRule("all", vpnIntf, "wan_routable", 5000, null, 4);
  }

  _getVPNClientIPSetName(vpnIntf) {
    return `vpn_client_${vpnIntf}_set`;
  }

  async enforceDNSRedirect(vpnIntf, dnsServers, remoteIP) {
    if (!vpnIntf || !dnsServers || dnsServers.length == 0)
      return;
    const rtId = await this.getRtId(vpnIntf);
    if (!rtId)
      return;
    const rtIdHex = Number(rtId).toString(16);
    const tableName = this._getRoutingTableName(vpnIntf);
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      // add to vpn client routing table
      if (remoteIP)
        await routing.addRouteToTable(dnsServer, remoteIP, vpnIntf, tableName).catch((err) => {});
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo iptables -w -t nat -I FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -I FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo iptables -w -t nat -I FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff  -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -I FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff  -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }

  async unenforceDNSRedirect(vpnIntf, dnsServers, remoteIP) {
    if (!vpnIntf || !dnsServers || dnsServers.length == 0)
      return;
    const rtId = await this.getRtId(vpnIntf);
    if (!rtId)
      return;
    const rtIdHex = Number(rtId).toString(16);
    const tableName = this._getRoutingTableName(vpnIntf);
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      // remove from vpn client routing table
      if (remoteIP)
        await routing.removeRouteFromTable(dnsServer, remoteIP, vpnIntf, tableName).catch((err) => {});
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/0xffff -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }
}

const instance = new VPNClientEnforcer();
module.exports = instance;