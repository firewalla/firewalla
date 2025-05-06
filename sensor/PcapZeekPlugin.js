/*    Copyright 2016-2024 Firewalla Inc.
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
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const PcapPlugin = require('./PcapPlugin.js');
const bro = require('../net2/BroDetect.js');
const broControl = require('../net2/BroControl.js');
const sysManager = require('../net2/SysManager.js');
const _ = require('lodash');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const {Address4, Address6} = require('ip-address');
const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');
const conntrack = require('../net2/Conntrack.js')
const uuid = require('uuid');
const Constants = require('../net2/Constants.js');

class PcapZeekPlugin extends PcapPlugin {

  async initLogProcessing() {
    bro.start();
  }

  async restart() {
    const zeekOptions = await this.calculateZeekOptions();
    if (platform.isFireRouterManaged())
      await broControl.writeClusterConfig(zeekOptions);

    const localNetworks = this.calculateLocalNetworks();
    await broControl.writeNetworksConfig(localNetworks);
    await broControl.restart().then(() => broControl.addCronJobs()).then(() => {
      log.info("Zeek restarted");
    });
  }

  async stop() {
    await broControl.stop();
    await broControl.removeCronJobs();
  }

  getFeatureName() {
    return "pcap_zeek";
  }

  calculateLocalNetworks() {
    const localNetworks = {};
    // add multicast ip range to local networks so that related traffic will be marked as local_resp/local_orig:true and will be directly bypassed in BroDetect.js
    const multicastV4 = "224.0.0.0/4";
    const multicastV6 = "ff00::/8";
    const monitoringIntfs = sysManager.getMonitoringInterfaces();
    for (const intf of monitoringIntfs) {
      if (intf.name === Constants.INTF_AP_CTRL)
        continue;
      const intfName = intf.name;
      const subnets4 = (_.isArray(intf.ip4_subnets) ? intf.ip4_subnets : []).concat(_.isArray(intf.rt4_subnets) ? intf.rt4_subnets : []).filter(cidr => cidr.includes('/') && !cidr.endsWith('/32') && !sysManager.isDefaultRoute(cidr)); // exclude single IP cidr, mainly for peer IP in mesh VPN that should be covered by another /24 cidr
      for (const ip of subnets4) {
        if (localNetworks[ip])
          localNetworks[ip].push(intfName);
        else
          localNetworks[ip] = [intfName];
      }
      if (localNetworks[multicastV4])
        localNetworks[multicastV4].push(intfName);
      else
        localNetworks[multicastV4] = [intfName];
      if (intf.ip6_subnets && _.isArray(intf.ip6_subnets)) {
        for (const ip of intf.ip6_subnets) {
          if (localNetworks[ip])
            localNetworks[ip].push(intfName);
          else
            localNetworks[ip] = [intfName];
        }
      }
      if (localNetworks[multicastV6])
        localNetworks[multicastV6].push(intfName);
      else
        localNetworks[multicastV6] = [intfName];
    }
    return localNetworks;
  }

  async calculateZeekOptions() {
    const listenInterfaces = await this.calculateListenInterfaces();
    const monitoredNetworks4 = [];
    const monitoredNetworks6 = [];
    const selfIp4 = [];
    const selfIp6 = [];
    const wanIp4 = [];
    const wanIp6 = [];
    for (const intf of sysManager.getMonitoringInterfaces()) {
      if (intf.name === Constants.INTF_AP_CTRL)
        continue;
      const ip4Subnets = intf.ip4_subnets;
      const ip6Subnets = intf.ip6_subnets;
      if (_.isArray(ip4Subnets)) {
        for (const ip4 of ip4Subnets) {
          const addr4 = new Address4(ip4);
          if (addr4.isValid())
            monitoredNetworks4.push(`${addr4.startAddress().correctForm()}/${addr4.subnetMask}`);
            selfIp4.push(addr4.correctForm());
        }
      }
      if (_.isArray(ip6Subnets)) {
        for (const ip6 of ip6Subnets) {
          const addr6 = new Address6(ip6);
          if (addr6.isValid())
            monitoredNetworks6.push(`${addr6.startAddress().correctForm()}/${addr6.subnetMask}`);
            selfIp6.push(addr6.correctForm());
        }
      }
    }
    for (const intf of sysManager.getWanInterfaces()) {
      if (_.isArray(intf.ip4_addresses))
        wanIp4.push(...intf.ip4_addresses);
      if (_.isArray(intf.ip6_addresses))
        wanIp6.push(...(intf.ip6_addresses.filter(addr => !addr.startsWith("fe80"))));
    }
    // do not capture intranet traffic, but still keep tcp SYN/FIN/RST for port scan detection
    const restrictFilters = {};
    if (!fc.isFeatureOn(Constants.FEATURE_LOCAL_FLOW)) {
      log.info('local_flow is off, dropping intranet traffic');
      if (!_.isEmpty(monitoredNetworks4))
        restrictFilters["not-intranet-ip4"] = `not (ip` +
          ` and (${monitoredNetworks4.map(net => `src net ${net}`).join(" or ")})` +
          ` and (${monitoredNetworks4.map(net => `dst net ${net}`).join(" or ")})` +
          ` and not (port 53 or port 8853 or port 22 or port 67 or port 68)` +
          ` and (not tcp or tcp[13] & 0x7 == 0))`; // No RST/SYN/FIN flags
      if (!_.isEmpty(monitoredNetworks6))
        restrictFilters["not-intranet-ip6"] = `not (ip6` +
          ` and (${monitoredNetworks6.map(net => `src net ${net}`).join(" or ")})` +
          ` and (${monitoredNetworks6.map(net => `dst net ${net}`).join(" or ")})` +
          ` and not (port 53 or port 8853 or port 22 or port 67 or port 68)` +
          ` and (not tcp or ip6[40+13] & 0x7 == 0))`; // No RST/SYN/FIN flags
    } else {
      // randomly drop local traffic packets without SYN/FIN/RST based on the first bit of the most significant byte of TCP checksum(tcp header offset +16), this can reduce 50% traffic
      if (!_.isEmpty(monitoredNetworks4))
        restrictFilters["not-intranet-ip4"] = `not (ip` +
          ` and (${monitoredNetworks4.map(net => `src net ${net}`).join(" or ")})` +
          ` and (${monitoredNetworks4.map(net => `dst net ${net}`).join(" or ")})` +
          ` and not (port 53 or port 8853 or port 22 or port 67 or port 68)` +
          ` and (tcp` +
            ` and tcp[13] & 0x7 == 0` + // No RST/SYN/FIN flags
            ` and (len >= 1000 || tcp[13] == 0x10)` + // Large packet or pure ACK
            ` and tcp[16] & 0x8 != 0` + // 50% sampling based on checksum
          `))`;
      if (!_.isEmpty(monitoredNetworks6))
        restrictFilters["not-intranet-ip6"] = `not (ip6` +
          ` and (${monitoredNetworks6.map(net => `src net ${net}`).join(" or ")})` +
          ` and (${monitoredNetworks6.map(net => `dst net ${net}`).join(" or ")})` +
          ` and not (port 53 or port 8853 or port 22 or port 67 or port 68)` +
          ` and (tcp` +
            ` and ip6[40+13] & 0x7 == 0` + // No RST/SYN/FIN flags
            ` and (len >= 1000 || ip6[40 + 13] == 0x10)` + // Large packet or pure ACK
            ` and ip6[40 + 16] & 0x8 != 0` + // 50% sampling based on checksum
          `))`;
    }
    // do not record TCP SYN originated from box, which is device port scan packets
    if (!_.isEmpty(selfIp4)) {
      restrictFilters["not-self-tx-syn-ip4"] = `not (ip` +
        ` and (${selfIp4.map(ip => `src host ${ip}`).join(" or ")})` +
        ` and not (port 53 or port 8853 or port 22 or port 67 or port 68)` +
        ` and (not tcp or tcp[13] & 0x12 == 2))`; // TCP SYN packets without ACK flag
      restrictFilters["not-self-rx-nosyn-ip4"] = `not (ip` +
        ` and (${selfIp4.map(ip => `dst host ${ip}`).join(" or ")})` +
        ` and not (port 53 or port 8853 or port 22 or port 67 or port 68)` +
        ` and (not tcp or tcp[13] & 0x12 != 2))`;
    }
    /* box won't do IPv6 port scan in practice, remove them from restrictFilters to reduce pcap filter expression length in zeek. Zeek may not work properly with an excessively long pcap filter expression
    if (!_.isEmpty(selfIp6)) {
      restrictFilters["not-self-tx-syn-ip6"] = `not (ip6 and (${selfIp6.map(ip => `src host ${ip}`).join(" or ")}) and not (port 53 or port 8853 or port 22 or port 67 or port 68) and (not tcp or ip6[40+13] & 0x12 == 2))`;
      restrictFilters["not-self-rx-nosyn-ip6"] = `not (ip6 and (${selfIp6.map(ip => `src host ${ip}`).join(" or ")}) and not (port 53 or port 8853 or port 22 or port 67 or port 68) and (not tcp or ip6[40+13] & 0x12 != 2))`;
    }
    */
    if (!_.isEmpty(wanIp4)) {
      restrictFilters["not-self-wan-ip4"] = `not (${wanIp4.map(ip => `host ${ip}`).join(' or ')})`;
    }
    if (!_.isEmpty(wanIp6)) {
      restrictFilters["not-self-wan-ip6"] = `not (${wanIp6.map(ip => `host ${ip}`).join(' or ')})`;
    }
    if (fc.isFeatureOn("fast_speedtest") && conntrack) {
      restrictFilters["not-tcp-port-8080"] = `not (tcp and port 8080)`;
      conntrack.registerConnHook({dport: 8080, protocol: "tcp"}, (connInfo) => {
        const {src, replysrc, sport, replysport, dst, dport, protocol, origPackets, respPackets, origBytes, respBytes, duration} = connInfo;
        const local_orig = Boolean(sysManager.getInterfaceViaIP(src));
        bro.processConnData(JSON.stringify(
          {
            "id.orig_h": src,
            "id.resp_h": local_orig ? dst : replysrc, // use replysrc for DNATed connection
            "id.orig_p": sport,
            "id.resp_p": local_orig ? dport : replysport,
            "proto": protocol,
            "orig_bytes": origBytes,
            "orig_pkts": origPackets,
            "resp_bytes": respBytes,
            "resp_pkts": respPackets,
            "orig_ip_bytes": origBytes + origPackets * 20,
            "resp_ip_bytes": respBytes + respPackets * 20,
            "missed_bytes": 0,
            "local_orig": local_orig,
            "local_resp": local_orig ? Boolean(sysManager.getInterfaceViaIP(dst)) : Boolean(sysManager.getInterfaceViaIP(replysrc)),
            "conn_state": "SF",
            "duration": duration,
            "ts": Date.now() / 1000 - duration,
            "uid": uuid.v4().substring(0, 8)
          }
        ))
      })
    }

    const sigFiles = [];
    const sigDir = `${f.getRuntimeInfoFolder()}/zeek_signatures`;
    const files = await fs.readdirAsync(sigDir).catch((err) => []);
    for (const file of files) {
      if (file.endsWith(".sig"))
        sigFiles.push(`${sigDir}/${file}`);
    }

    return {listenInterfaces, restrictFilters, sigFiles};
  }

  getPcapBufsize(intfName) {
    const intfMatch = intfName.match(/^[^\d]+/)
    return intfMatch ? platform.getZeekPcapBufsize()[intfMatch[0]] : undefined
  }

  async isSupported() {
    return fs.accessAsync(`/usr/local/${platform.getBroProcName()}/bin/${platform.getBroProcName()}`, fs.constants.F_OK).then(() => true).catch((err) => false);
  }

}

module.exports = PcapZeekPlugin;
