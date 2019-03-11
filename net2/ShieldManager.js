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
          // add/update device ip address to trusted_ip_set/trusted_ip_set6
          const host = event.host;
          if (host.ipv4Addr) {
            log.info("Update device ip in trusted_ip_set: " + host.ipv4Addr);
            const cmd = util.format("sudo ipset add -! trusted_ip_set %s", host.ipv4Addr);
            exec(cmd);
          }
          if (host.ipv6Addr && host.ipv6Addr.length > 0) {
            host.ipv6Addr.forEach(ipv6Addr => {
              log.info("Update device ip in trusted_ip_set6: " + ipv6Addr);
              const cmd = util.format("sudo ipset add -! trusted_ip_set6 %s", ipv6Addr);
              exec(cmd);
            });
          }
          // update ip address to protected_ip_set/protected_ip_set6
          if (host.mac && this.protected_macs[host.mac]) {
            this.activateShield(host.mac);
          }
        });

        this.protected_macs = {};

        this._updateTrustedIPSet();
        setInterval(() => {
          this._updateTrustedIPSet();
          this._updateProtectedIPSet();
        }, 300000); // update trusted_ip_set and protected_ip_set once every 5 minutes
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
    const macs = Object.keys(this.protected_macs);
    for (let i in macs) {
      await this.activateShield(macs[i]);
    }
  }

  async _updateTrustedIPSet() {
    const macEntries = await hostTool.getAllMACEntries();
    const allIpv4Addrs = {};
    const allIpv6Addrs = {};
    for (let i in macEntries) {
      const macEntry = macEntries[i];
      const ipv4Addr = macEntry.ipv4Addr;
      if (ipv4Addr && ip.isV4Format(ipv4Addr)) {
        allIpv4Addrs[ipv4Addr] = 1;
      }
      let ipv6Addrs = [];
      if (macEntry.ipv6Addr)
        ipv6Addrs = JSON.parse(macEntry.ipv6Addr);
      if (ipv6Addrs && ipv6Addrs.length > 0) {
        for (let j in ipv6Addrs) {
          const ipv6Addr = ipv6Addrs[j];
          if (ipv6Addr && ip.isV6Format(ipv6Addr)) {
            allIpv6Addrs[ipv6Addr] = 1;
          }
        }  
      }
    }
    for (let ip in allIpv4Addrs) {
      log.info("Add ip to trusted_ip_set: " + ip);
      const cmd = util.format("sudo ipset add -! trusted_ip_set %s", ip);
      await exec(cmd);
    }
    for (let ip in allIpv6Addrs) {
      log.info("Add ip to trusted_ip_set6: " + ip);
      const cmd = util.format("sudo ipset add -! trusted_ip_set6 %s", ip);
      await exec(cmd);
    }
  }

  async _updateVPNOutgoingRules(vpnSubnet) {
    if (this.vpnSubnet) {
      // remove old vpn subnet
      const cmd = util.format("sudo ipset -! del trusted_ip_set %s", this.vpnSubnet);
      await exec(cmd);
      this.vpnSubnet = null;
    }
    if (vpnSubnet) {
      // add new vpn subnet
      const cmd = util.format("sudo ipset add -! trusted_ip_set %s", vpnSubnet);
      await exec(cmd);
      this.vpnSubnet = vpnSubnet;
    }
  }

  async activateShield(mac) {
    if (!mac) {
      // enable shield globally
      let cmd = "sudo iptables -w -C FORWARD -j FW_SHIELD || sudo iptables -w -A FORWARD -j FW_SHIELD";
      await exec(cmd).catch((err) => {
        log.error("Failed to activate global shield in iptables", err);
      });
  
      cmd = "sudo ip6tables -w -C FORWARD -j FW_SHIELD || sudo ip6tables -w -A FORWARD -j FW_SHIELD";
      await exec(cmd).catch((err) => {
        log.error("Failed to activate global shield in ip6tables", err);
      });
    } else {
      // per-device shield
      const macEntry = await hostTool.getMACEntry(mac);
      if (!macEntry) {
        log.error("Cannot find host info of " + mac);
        return;
      }
      
      if (this.protected_macs[mac]) {
        const legacyMacEntry = this.protected_macs[mac];
        const legacyIpv6Addrs = (legacyMacEntry.ipv6Addrs || []).sort();
        const ipv6Addrs = (macEntry.ipv6Addrs || []).sort();
        if (macEntry.ipv4Addr !== legacyMacEntry.ipv4Addr || ipv6Addrs.length !== legacyIpv6Addrs.length || !ipv6Addrs.every((value, index) => {return value === legacyIpv6Addrs[index]})) {
          // ip addresses may be changed
          log.info("IP addresses of " + mac + " have been changed.")
          await this.deactivateShield(mac);
        } else {
          log.info("IP addresses of " + mac + " are not changed.");
        }
      }
      
      this.protected_macs[mac] = macEntry;
      const ipv4Addr = macEntry.ipv4Addr;
      if (ipv4Addr && ip.isV4Format(ipv4Addr)) {
        log.info("Add ip to protected_ip_set: " + ipv4Addr);
        const cmd = util.format("sudo ipset add -! protected_ip_set %s", ipv4Addr);
        await exec(cmd).catch((err) => {
          log.error("Failed to add " + ipv4Addr + " to protected_ip_set", err);
        });
      }
      let ipv6Addrs = [];
      if (macEntry.ipv6Addr)
        ipv6Addrs = JSON.parse(macEntry.ipv6Addr);
      if (ipv6Addrs && ipv6Addrs.length > 0) {
        for (let j in ipv6Addrs) {
          const ipv6Addr = ipv6Addrs[j];
          if (ipv6Addr && ip.isV6Format(ipv6Addr)) {
            log.info("Add ip to protected_ip_set6: " + ipv6Addr);
            const cmd = util.format("sudo ipset add -! protected_ip_set6 %s", ipv6Addr);
            await exec(cmd).catch((err) => {
              log.error("Failed to add " + ipv4Addr + " to protected_ip_set6", err);
            });
          }
        }  
      }
    }
  }

  async deactivateShield(mac) {
    if (!mac) {
      // disable shield globally
      let cmd = "sudo iptables -w -C FORWARD -j FW_SHIELD && sudo iptables -w -D FORWARD -j FW_SHIELD";
      await exec(cmd).catch((err) => {
        log.error("Failed to deactivate global shield in iptables", err);
      });
  
      cmd = "sudo ip6tables -w -C FORWARD -j FW_SHIELD && sudo ip6tables -w -D FORWARD -j FW_SHIELD";
      await exec(cmd).catch((err) => {
        log.error("Failed to deactivate global shield in ip6tables", err);
      });
    } else {
      if (this.protected_macs[mac]) {
        const macEntry = this.protected_macs[mac];
        if (!macEntry)
          return;
        const ipv4Addr = macEntry.ipv4Addr;
        if (ipv4Addr && ip.isV4Format(ipv4Addr)) {
          log.info("Remove ip from protected_ip_set: " + ipv4Addr);
          const cmd = util.format("sudo ipset del -! protected_ip_set %s", ipv4Addr);
          await exec(cmd).catch((err) => {
            log.error("Failed to remove " + ipv4Addr + " from protected_ip_set", err);
          });
        }
        let ipv6Addrs = [];
        if (macEntry.ipv6Addr)
          ipv6Addrs = JSON.parse(macEntry.ipv6Addr);
        if (ipv6Addrs && ipv6Addrs.length > 0) {
          for (let j in ipv6Addrs) {
            const ipv6Addr = ipv6Addrs[j];
            if (ipv6Addr && ip.isV6Format(ipv6Addr)) {
              log.info("Remove ip from protected_ip_set6: " + ipv6Addr);
              const cmd = util.format("sudo ipset add -! protected_ip_set6 %s", ipv6Addr);
              await exec(cmd).catch((err) => {
                log.error("Failed to remove " + ipv6Addr + " from protected_ip_set6", err);
              });
            }
          }
        }
        delete this.protected_macs[mac];
      } else {
        log.warn("Device " + mac + " is not protected, no need to deactivate shield.");
      }      
    }
  }
}

module.exports = ShieldManager;
