/*    Copyright 2016-2021 Firewalla Inc.
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
      const intfName = intf.name;
      if (intf.ip4_subnets && _.isArray(intf.ip4_subnets)) {
        for (const ip of intf.ip4_subnets) {
          if (localNetworks[ip])
            localNetworks[ip].push(intfName);
          else
            localNetworks[ip] = [intfName];
        }
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
    const monitoredNetworks = _.uniq(sysManager.getMonitoringInterfaces().flatMap(intf => {
      const ip4Subnets = intf.ip4_subnets;
      const ip6Subnets = intf.ip6_subnets;
      const localSubnets = [];
      if (_.isArray(ip4Subnets)) {
        for (const ip4 of ip4Subnets) {
          const addr4 = new Address4(ip4);
          if (addr4.isValid())
            localSubnets.push(`${addr4.startAddress().correctForm()}/${addr4.subnetMask}`);
        }
      }
      if (_.isArray(ip6Subnets)) {
        for (const ip6 of ip6Subnets) {
          const addr6 = new Address6(ip6);
          if (addr6.isValid())
            localSubnets.push(`${addr6.startAddress().correctForm()}/${addr6.subnetMask}`);
        }
      }
      return localSubnets;
    }));
    return {
      listenInterfaces,
      // do not capture intranet traffic, but still keep tcp SYN/FIN/RST for port scan detection
      restrictFilters: {"not-intranet": `not ((${monitoredNetworks.map(net => `src net ${net}`).join(" or ")}) and (${monitoredNetworks.map(net => `dst net ${net}`).join(" or ")}) and not port 53 and not port 8853 and (not tcp or tcp[13] & 0x7 == 0))`}
    };
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