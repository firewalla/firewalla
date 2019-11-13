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
      instance = this;
    }
    return instance;
  }

  _getRoutingTableName(vpnIntf) {
    return `${VPN_CLIENT_RULE_TABLE_PREFIX}_${vpnIntf}`;
  }

  async _ensureCreateIpset(ipset) {
    if (ipset && !createdIpset.includes(ipset)) {
      await execAsync(`sudo ipset create -! ${ipset} hash:ip family inet hashsize 128 maxelem 65536`);
      createdIpset.push(ipset);
    }
  }

  async enableInterfaceVPNAccess(fromIntf, vpnIntf) {
    // assume interface name will not change after it is enabled
    if (!fromIntf)
      throw "src interface is not defined";
    if (!vpnIntf)
      throw "VPN interface is not defined";
    const tableName = this._getRoutingTableName(vpnIntf);

    // ensure customized routing table is created
    await routing.createCustomizedRoutingTable(tableName);
    // this is system policy, not per-device policy. It is applied to a specific incoming interface
    log.info(`Add vpn client routing rule for incoming interface ${fromIntf} to ${vpnIntf}`);
    await routing.createPolicyRoutingRule("all", fromIntf, tableName);
  }

  async disableInterfaceVPNAccess(fromIntf, vpnIntf) {
    // assume interface name will not change after it is enabled
    if (!fromIntf)
      throw "src interface is not defined";
    if (!vpnIntf)
      throw "VPN interface is not defined";
    const tableName = this._getRoutingTableName(vpnIntf);

    // ensure customized routing table is created
    await routing.createCustomizedRoutingTable(tableName);
    // this is system policy, not per-device policy. It is applied to a specific incoming interface
    log.info(`Remove vpn client routing rule for incoming interface ${fromIntf} to ${vpnIntf}`);
    await routing.removePolicyRoutingRule("all", fromIntf, tableName);
  }

  async enableVPNAccess(mac, mode, vpnIntf) {
    if (!vpnIntf)
      throw "VPN interface is not defined";
    const tableName = this._getRoutingTableName(vpnIntf);
    const vpnClientIpset = this._getVPNClientIPSetName(vpnIntf);
    const host = await hostTool.getMACEntry(mac);
    const legacyHost = this.enabledHosts[mac] || null;
    
    // ensure customized routing table is created
    await routing.createCustomizedRoutingTable(tableName);
    host.vpnClientMode = mode;
    let legacyVpnClientIpset = null;
    let legacyTableName = null;
    if (legacyHost && legacyHost.vpnClientIntf) {
      legacyVpnClientIpset = this._getVPNClientIPSetName(legacyHost.vpnClientIntf);
      legacyTableName = this._getRoutingTableName(legacyHost.vpnClientIntf);
    }
    host.vpnClientIntf = vpnIntf;
    this.enabledHosts[mac] = host;
    switch (mode) {
      case "dhcp":
        const mode = require('../../net2/Mode.js');
        await mode.reloadSetupMode();
        // enforcement takes effect if devcie ip address is in overlay network or dhcp spoof mode is on
        if (this._isSecondaryInterfaceIP(host.ipv4Addr) || await mode.isDHCPSpoofModeOn()) {
          try {
            // remove previous policy routing rule and ipset presence if present. This usually happens in case of profile switch
            if (legacyHost && legacyHost.ipv4Addr && legacyTableName)
              await routing.removePolicyRoutingRule(legacyHost.ipv4Addr, fConfig.monitoringInterface, legacyTableName);
            if (legacyVpnClientIpset && legacyHost && legacyHost.ipv4Addr) {
              await this._ensureCreateIpset(legacyVpnClientIpset);
              const cmd = `sudo ipset del -! ${legacyVpnClientIpset} ${legacyHost.ipv4Addr}`;
              await execAsync(cmd);
            }
          } catch (err) {
            log.error("Failed to remove policy routing rule for " + legacyHost.ipv4Addr, err);
          }
          if (host.spoofing === "true") {
            log.info(`Add vpn client routing rule for ${host.ipv4Addr} to ${vpnIntf}`);
            await routing.createPolicyRoutingRule(host.ipv4Addr, fConfig.monitoringInterface, tableName);
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
      const vpnIntf = host.vpnClientIntf;
      const tableName = this._getRoutingTableName(vpnIntf);
      const vpnClientIpset = this._getVPNClientIPSetName(vpnIntf);
      try {
        await routing.removePolicyRoutingRule(host.ipv4Addr, fConfig.monitoringInterface, tableName); // remove ip rule from host address regardless of src interface
        await this._ensureCreateIpset(vpnClientIpset);
        const cmd = `sudo ipset del -! ${vpnClientIpset} ${host.ipv4Addr}`;
        await execAsync(cmd);
      } catch (err) {
        log.error(`Failed to disable VPN access for ${host.ipv4Addr} to ${vpnIntf}`, err);
      }
      delete this.enabledHosts[mac];
    }
  }

  async enforceStrictVPN(vpnIntf) {
    if (!vpnIntf) {
      throw "Interface is not specified";
    }
    const vpnClientIpset = this._getVPNClientIPSetName(vpnIntf);
    await this._ensureCreateIpset(vpnClientIpset);
    const cmd = wrapIptables(`sudo iptables -w -A FORWARD -m set --match-set ${vpnClientIpset} src -m set ! --match-set trusted_ip_set dst ! -o ${vpnIntf} -j FW_DROP`);
    await execAsync(cmd).catch((err) => {
      log.error(`Failed to enforce strict vpn on ${vpnIntf}`, err);
    });
  }

  async unenforceStrictVPN(vpnIntf) {
    if (!vpnIntf) {
      throw "Interface is not specified";
    }
    const vpnClientIpset = this._getVPNClientIPSetName(vpnIntf);
    await this._ensureCreateIpset(vpnClientIpset);
    const cmd = wrapIptables(`sudo iptables -w -D FORWARD -m set --match-set ${vpnClientIpset} src -m set ! --match-set trusted_ip_set dst ! -o ${vpnIntf} -j FW_DROP`);
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
    await routing.createCustomizedRoutingTable(tableName);
    // add routes from main routing table to vpn client table
    await routing.flushRoutingTable(tableName);
    let cmd = "ip route list";
    if (overrideDefaultRoute)
      // do not copy default route from main routing table
      cmd = "ip route list | grep -v default";
    const routes = await execAsync(cmd);
    await Promise.all(routes.stdout.split('\n').map(async route => {
      if (route.length > 0) {
        cmd = util.format("sudo ip route add %s table %s", route, tableName);
        await execAsync(cmd).catch((err) => {
          // this usually happens when multiple function calls are executed simultaneously. It should have no side effect and will be consistent eventually
          log.warn(`Failed to add route, ${cmd}`, err);
        });
      }
    }));
    for (let routedSubnet of routedSubnets) {
      const cidr = ipTool.cidrSubnet(routedSubnet);
      // change subnet to ip route acceptable format
      const formattedSubnet = `${cidr.networkAddress}/${cidr.subnetMaskLength}`;
      await routing.addRouteToTable(formattedSubnet, remoteIP, vpnIntf, tableName).catch((err) => {
        log.error(`Failed to add '${formattedSubnet} via ${remoteIP} dev ${vpnIntf} table ${tableName}`, err);
      });
    }
    if (overrideDefaultRoute) {
      // then add remote IP as gateway of default route to vpn client table
      await routing.addRouteToTable("default", remoteIP, vpnIntf, tableName).catch((err) => {
        // this usually happens when multiple function calls are executed simultaneously. It should have no side effect and will be consistent eventually
        log.warn(`Failed to add default router via ${remoteIP} dev ${vpnIntf} table ${tableName}`, err);
      });
    }
  }

  async flushVPNClientRoutes(vpnIntf) {
    if (!vpnIntf)
      throw "Interface is not specified";
    const tableName = this._getRoutingTableName(vpnIntf);
    await routing.createCustomizedRoutingTable(tableName);
    await routing.flushRoutingTable(tableName);
  }

  _getVPNClientIPSetName(vpnIntf) {
    return `vpn_client_${vpnIntf}_set`;
  }

  async enforceInterfaceDNSRedirect(srcIntf, vpnIntf, dnsServers) {
    if (!srcIntf || !vpnIntf || dnsServers.length == 0)
      return;
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -i ${srcIntf} -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, src intf: ${srcIntf}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -i ${srcIntf} -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, src intf: ${srcIntf}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -i ${srcIntf} -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, src intf: ${srcIntf}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -i ${srcIntf} -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, src intf: ${srcIntf}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }

  async unenforceInterfaceDNSRedirect(srcIntf, vpnIntf, dnsServers) {
    if (!srcIntf || !vpnIntf || dnsServers.length == 0)
      return;
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -i ${srcIntf} -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to unenforce DNS redirect rule: ${cmd}, src intf: ${srcIntf}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -i ${srcIntf} -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to unenforce DNS redirect rule: ${cmd}, src intf: ${srcIntf}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -i ${srcIntf} -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to unenforce DNS redirect rule: ${cmd}, src intf: ${srcIntf}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -i ${srcIntf} -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to unenforce DNS redirect rule: ${cmd}, src intf: ${srcIntf}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }

  async enforceDNSRedirect(vpnIntf, dnsServers) {
    if (!vpnIntf || !dnsServers || dnsServers.length == 0)
      return;
    const vpnClientIpset = this._getVPNClientIPSetName(vpnIntf);
    await this._ensureCreateIpset(vpnClientIpset);
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -I PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }

  async unenforceDNSRedirect(vpnIntf, dnsServers) {
    if (!vpnIntf || !dnsServers || dnsServers.length == 0)
      return;
    const vpnClientIpset = this._getVPNClientIPSetName(vpnIntf);
    await this._ensureCreateIpset(vpnClientIpset);
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D PREROUTING_DNS_VPN_CLIENT -m set --match-set ${vpnClientIpset} src -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
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
              await routing.removePolicyRoutingRule(oldHost.ipv4Addr, fConfig.monitoringInterface, tableName);
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