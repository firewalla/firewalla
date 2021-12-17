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
const FireRouter = require('../net2/FireRouter.js');
const Config = require('../net2/config.js');
const exec = require('child-process-promise').exec;

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
    await exec(`sudo systemctl stop brofish`);
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
    if (platform.isFireRouterManaged()) {
      const intfNameMap = await FireRouter.getInterfaceAll();
      const monitoringInterfaces = FireRouter.getMonitoringIntfNames();
      const parentIntfOptions = {};
      const monitoringIntfOptions = {}
      for (const intfName in intfNameMap) {
        if (!monitoringInterfaces.includes(intfName))
          continue;
        const intf = intfNameMap[intfName];
        const isBond = intfName && intfName.startsWith("bond") && !intfName.includes(".");
        const subIntfs = !isBond && intf.config && intf.config.intf;
        if (!subIntfs) {
          monitoringIntfOptions[intfName] = parentIntfOptions[intfName] = { pcapBufsize: this.getPcapBufsize(intfName) };
        } else {
          const phyIntfs = []
          if (typeof subIntfs === 'string') {
            // strip vlan tag if present
            phyIntfs.push(subIntfs.split('.')[0])
          } else if (Array.isArray(subIntfs)) {
            // bridge interface can have multiple sub interfaces
            phyIntfs.push(...subIntfs.map(i => i.split('.')[0]))
          }
          let maxPcapBufsize = 0
          for (const phyIntf of phyIntfs) {
            if (!parentIntfOptions[phyIntf]) {
              const pcapBufsize = this.getPcapBufsize(phyIntf)
              parentIntfOptions[phyIntf] = { pcapBufsize };
              if (pcapBufsize > maxPcapBufsize)
                maxPcapBufsize = pcapBufsize
            }
          }
          monitoringIntfOptions[intfName] = { pcapBufsize: maxPcapBufsize };
        }
      }
      if (monitoringInterfaces.length <= Object.keys(parentIntfOptions).length)
        return {
          listenInterfaces: monitoringIntfOptions,
          restrictFilters: {}
        };
      else
        return {
          listenInterfaces: parentIntfOptions,
          restrictFilters: {}
        };
    } else {
      const fConfig = Config.getConfig(true);
      const intf = fConfig.monitoringInterface || "eth0";
      return {
        listenInterfaces: {
          intf: { pcapBufsize: this.getPcapBufsize(intf) }
        },
        restrictFilters: {}
      };
    }
    
  }

  getPcapBufsize(intfName) {
    const intfMatch = intfName.match(/^[^\d]+/)
    return intfMatch ? platform.getZeekPcapBufsize()[intfMatch[0]] : undefined
  }

}

module.exports = PcapZeekPlugin;