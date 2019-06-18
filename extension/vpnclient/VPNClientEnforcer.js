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
const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();
const Config = require('../../net2/config.js');
let fConfig = Config.getConfig();

const iptables = require('../../net2/Iptables.js');
const wrapIptables = iptables.wrapIptables;

const SysManager = require('../../net2/SysManager.js');

const execAsync = util.promisify(cp.exec);
var instance = null;

const VPN_CLIENT_RULE_TABLE_PREFIX = "vpn_client";

const createdIpset = [];

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
      }, 60 * 1000); // once every minute
    }
    return instance;
  }

  _getRoutingTableName(intf) {
    return `${VPN_CLIENT_RULE_TABLE_PREFIX}_${intf}`;
  }

  async _ensureCreateIpset(ipset) {
    if (ipset && !createdIpset.includes(ipset)) {
      await execAsync(`sudo ipset create -! ${ipset} hash:ip family inet hashsize 128 maxelem 65536`);
      createdIpset.push(ipset);
    }
  }

  async enableVPNAccess(mac, mode, intf) {
    if (!intf)
      throw "interface is not defined";
    const tableName = this._getRoutingTableName(intf);
    const vpnClientIpset = this._getVPNClientIPSetName(intf);
    const host = await hostTool.getMACEntry(mac);
    const legacyHost = this.enabledHosts[mac] || null;
    
    // ensure customized routing table is created
    await routing.createCustomizedRoutingTable(tableName);
    host.vpnClientMode = mode;
    let legacyVpnClientIpset = null;
    if (legacyHost && legacyHost.vpnClientIntf)
      legacyVpnClientIpset = this._getVPNClientIPSetName(legacyHost.vpnClientIntf);
    host.vpnClientIntf = intf;
    this.enabledHosts[mac] = host;
    switch (mode) {
      case "dhcp":
        const mode = require('../../net2/Mode.js');
        await mode.reloadSetupMode();
        // enforcement takes effect if devcie ip address is in overlay network or dhcp spoof mode is on
        if (this._isSecondaryInterfaceIP(host.ipv4Addr) || await mode.isDHCPSpoofModeOn()) {
          try {
            // remove previous policy routing rule and ipset presence if present. This usually happens in case of profile switch
            if (legacyHost && legacyHost.ipv4Addr)
              await routing.removePolicyRoutingRule(legacyHost.ipv4Addr);
            if (legacyVpnClientIpset) {
              await this._ensureCreateIpset(legacyVpnClientIpset);
              const cmd = `sudo ipset del -! ${legacyVpnClientIpset} ${host.ipv4Addr}`;
              await execAsync(cmd);
            }
          } catch (err) {
            log.error("Failed to remove policy routing rule for " + host.ipv4Addr, err);
          }
          if (host.spoofing === "true") {
            log.info("Add vpn client routing rule for " + host.ipv4Addr);
            await routing.createPolicyRoutingRule(host.ipv4Addr, fConfig.monitoringInterface || "eth0", tableName);
            await this._ensureCreateIpset(vpnClientIpset);
            const cmd = `sudo ipset add -! ${vpnClientIpset} ${host.ipv4Addr}`;
            await execAsync(cmd);
          }
        } else {
          log.warn(util.format("IP address %s is not assigned by secondary interface, vpn access of %s is suspended.", host.ipv4Addr, mac));
        }
        break;
      default:
        log.error("Unsupported vpn client mode: " + mode);
    }  
  }

  async disableVPNAccess(mac) {
    if (this.enabledHosts[mac]) {
      const host = this.enabledHosts[mac];
      const intf = host.vpnClientIntf;
      const tableName = this._getRoutingTableName(intf);
      const vpnClientIpset = this._getVPNClientIPSetName(intf);
      try {
        await routing.removePolicyRoutingRule(host.ipv4Addr, null, tableName); // remove ip rule from host address regardless of src interface
        await this._ensureCreateIpset(vpnClientIpset);
        const cmd = `sudo ipset del -! ${vpnClientIpset} ${host.ipv4Addr}`;
        await execAsync(cmd);
      } catch (err) {
        log.error("Failed to disable VPN access for " + host.ipv4Addr, err);
      }
      delete this.enabledHosts[mac];
    }
  }

  async enforceVPNClientRoutes(remoteIP, intf) {
    if (!intf)
      throw "Interface is not specified";
    const tableName = this._getRoutingTableName(intf);
    // ensure customized routing table is created
    await routing.createCustomizedRoutingTable(tableName);
    // add routes from main routing table to vpn client table except default route
    await routing.flushRoutingTable(tableName);
    let cmd = "ip route list | grep -v default";
    const routes = await execAsync(cmd);
    await Promise.all(routes.stdout.split('\n').map(async route => {
      if (route.length > 0) {
        cmd = util.format("sudo ip route add %s table %s", route, tableName);
        await execAsync(cmd);
      }
    }));
    // then add remote IP as gateway of default route to vpn client table
    await routing.addRouteToTable("default", remoteIP, intf, tableName);
  }

  async flushVPNClientRoutes(intf) {
    if (!intf)
      throw "Interface is not specified";
    const tableName = this._getRoutingTableName(intf);
    await routing.createCustomizedRoutingTable(tableName);
    await routing.flushRoutingTable(tableName);
  }

  _getVPNClientIPSetName(intf) {
    return `vpn_client_${intf}_set`;
  }

  async enforceDNSRedirect(intf, dnsServers) {
    if (!intf || !dnsServers || dnsServers.length == 0)
      return;
    const vpnClientIpset = this._getVPNClientIPSetName(intf);
    await this._ensureCreateIpset(vpnClientIpset);
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${intf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${intf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${intf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${intf}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }

  async unenforceDNSRedirect(intf, dnsServers) {
    if (!intf || !dnsServers || dnsServers.length == 0)
      return;
    const vpnClientIpset = this._getVPNClientIPSetName(intf);
    await this._ensureCreateIpset(vpnClientIpset);
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${intf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${intf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${intf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${intf}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }

  async _periodicalRefreshRule() {
    await Promise.all(Object.keys(this.enabledHosts).map(async mac => {
      const host = await hostTool.getMACEntry(mac);
      const oldHost = this.enabledHosts[mac];
      const enabledMode = oldHost.vpnClientMode;
      host.vpnClientMode = enabledMode;
      host.vpnClientIntf = oldHost.vpnClientIntf;
      const tableName = this._getRoutingTableName(host.vpnClientIntf);
      const vpnClientIpset = this._getVPNClientIPSetName(host.vpnClientIntf);
      switch (enabledMode) {
        case "dhcp":
          const mode = require('../../net2/Mode.js');
          await mode.reloadSetupMode();
          if (host.ipv4Addr !== oldHost.ipv4Addr || (!this._isSecondaryInterfaceIP(host.ipv4Addr) && !(await mode.isDHCPSpoofModeOn())) || host.spoofing === "false") {
            // policy routing rule should be removed anyway if ip address is changed or ip address is not assigned by secondary interface
            // or host is not monitored
            try {
              await routing.removePolicyRoutingRule(oldHost.ipv4Addr, fConfig.monitoringInterface || "eth0", tableName);
              await this._ensureCreateIpset(vpnClientIpset);
              const cmd = `sudo ipset del -! ${vpnClientIpset} ${oldHost.ipv4Addr}`;
              await execAsync(cmd);
            } catch (err) {
              log.error("Failed to remove policy routing rule for " + host.ipv4Addr, err);
            }
          }
          if ((this._isSecondaryInterfaceIP(host.ipv4Addr) || await mode.isDHCPSpoofModeOn()) && host.spoofing === "true") {
            await routing.createPolicyRoutingRule(host.ipv4Addr, fConfig.monitoringInterface || "eth0", tableName);
            await this._ensureCreateIpset(vpnClientIpset);
            const cmd = `sudo ipset add -! ${vpnClientIpset} ${host.ipv4Addr}`;
            await execAsync(cmd);
          }
          this.enabledHosts[mac] = host;
          break;
        default:
          log.error("Unsupported vpn client mode: " + enabledMode);
      }
    }));
  }

  _isSecondaryInterfaceIP(ip) {
    const sysManager = new SysManager();
    const ip2 = sysManager.myIp2();
    const ipMask2 = sysManager.myIpMask2();
    
    if(ip && ip2 && ipMask2) {
      return ipTool.subnet(ip2, ipMask2).contains(ip);
    }
    return false;
  }
}

module.exports = VPNClientEnforcer;