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

const log = require("./logger.js")(__filename);

const firewalla = require('./Firewalla.js');
const HostTool = require('./HostTool.js');
const hostTool = new HostTool();

const ip = require('ip');

const exec = require('child-process-promise').exec

const sem = require('../sensor/SensorEventManager.js').getInstance();

const util = require('util');

const sclient = require('../util/redis_manager.js').getSubscriptionClient();
var instance = null;

class ShieldManager {
  constructor() {
    if (!instance) {
      sclient.on("message", (channel, message) => {
        switch (channel) {
          case "System:VPNSubnetChanged":
            const newVpnSubnet = message;
            this._updateVPNOutgoingRules(newVpnSubnet);
            break;
          default:

        }
      });
      if (firewalla.isMain()) {
        sclient.subscribe("System:VPNSubnetChanged");

        sem.on("DeviceUpdate", (event) => {
          // add/update device ip address to trusted_ip_set/trusted_ip_set_6
          const host = event.host;
          if (host.ipv4Addr) {
            log.info("Update device ip in trusted_ip_set: " + host.ipv4Addr);
            const cmd = util.format("sudo ipset add -! trusted_ip_set %s", host.ipv4Addr);
            exec(cmd);
          }
          if (host.ipv6Addr && host.ipv6Addr.length > 0) {
            host.ipv6Addr.forEach(ipv6Addr => {
              log.info("New device found add to trusted_ip_set6: " + ipv6Addr);
              const cmd = util.format("sudo ipset add -! trusted_ip_set6 %s", ipv6Addr);
              exec(cmd);
            });
          }
        });

        this._updateProtectedIPSet();
        setInterval(() => {
          this._updateProtectedIPSet();
        }, 300000); // update protected_mac_set once every 5 minutes
      }
    }
    return instance;
  }

  async addIncomingRule(protocol, dstIp, dstPort) {
    log.info(util.format("Add incoming rule to %s:%s, protocol %s", dstIp, dstPort, protocol));
    const cmd = util.format("sudo iptables -w -C FW_SHIELD -p %s -d %s --dport %s -j RETURN || sudo iptables -w -I FW_SHIELD -p %s -d %s --dport %s -j RETURN", 
      protocol, dstIp, dstPort, protocol, dstIp, dstPort);
    await exec(cmd);
  }

  async removeIncomingRule(protocol, dstIp, dstPort) {
    log.info(util.format("Remove incoming rule to %s:%s, protocol %s", dstIp, dstPort, protocol));
    const cmd = util.format("sudo iptables -w -C FW_SHIELD -p %s -d %s --dport %s -j RETURN && sudo iptables -w -D FW_SHIELD -p %s -d %s --dport %s -j RETURN", 
      protocol, dstIp, dstPort, protocol, dstIp, dstPort);
    await exec(cmd);
  }

  async _updateProtectedIPSet() {
    const macEntries = await hostTool.getAllMACEntries();
    for (let i in macEntries) {
      const macEntry = macEntries[i];
      const ipv4Addr = macEntry.ipv4Addr;
      if (ipv4Addr && ip.isV4Format(ipv4Addr)) {
        log.info("Add ip to trusted_ip_set: " + ipv4Addr);
        const cmd = util.format("sudo ipset add -! trusted_ip_set %s", ipv4Addr);
        await exec(cmd);
      }
      const ipv6Addrs = macEntry.ipv6Addr;
      if (ipv6Addrs && ipv6Addrs.length > 0) {
        for (let j in ipv6Addrs) {
          const ipv6Addr = ipv6Addrs[j];
          if (ipv6Addr && ip.isV6Format(ipv6Addr)) {
            log.info("Add ip to trusted_ip_set6: " + ipv6Addr);
            const cmd = util.format("sudo ipset add -! trusted_ip_set6 %s", ipv6Addr);
            await exec(cmd);
          }
        }  
      }
    }
  }

  async _updateVPNOutgoingRules(vpnSubnet) {
    if (this.vpnSubnet) {
      // remove old vpn subnet
      const cmd = util.format("sudo iptables -w -C FW_SHIELD -p all -s %s -j RETURN && sudo iptables -w -D FW_SHIELD -p all -s %s -j RETURN", this.vpnSubnet, this.vpnSubnet);
      await exec(cmd);
      this.vpnSubnet = null;
    }
    if (vpnSubnet) {
      // add new vpn rule
      const cmd = util.format("sudo iptables -w -C FW_SHIELD -p all -s %s -j RETURN || sudo iptables -w -I FW_SHIELD -p all -s %s -j RETURN", vpnSubnet, vpnSubnet);
      await exec(cmd);
      this.vpnSubnet = vpnSubnet;
    }
  }

  async activateShield() {
    // append FW_SHIELD chain to FORWARD chain
    let cmd = "sudo iptables -w -C FORWARD -j FW_SHIELD || sudo iptables -w -A FORWARD -j FW_SHIELD";
    await exec(cmd);

    cmd = "sudo ip6tables -w -C FORWARD -j FW_SHIELD || sudo ip6tables -w -A FORWARD -j FW_SHIELD";
    await exec(cmd);
  }

  async deactivateShield() {
    // remove FW_SHIELD chain from FORWARD chain
    let cmd = "sudo iptables -w -C FORWARD -j FW_SHIELD && sudo iptables -w -D FORWARD -j FW_SHIELD";
    await exec(cmd);

    cmd = "sudo ip6tables -w -C FORWARD -j FW_SHIELD && sudo ip6tables -w -D FORWARD -j FW_SHIELD";
    await exec(cmd);
  }
}

module.exports = ShieldManager;