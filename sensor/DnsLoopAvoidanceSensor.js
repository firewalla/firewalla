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

const Sensor = require('./Sensor.js').Sensor;

const sysManager = require('../net2/SysManager.js');

const HostManager = require('../net2/HostManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const _ = require('lodash');

class DnsLoopAvoidanceSensor extends Sensor {
  run() {
    setInterval(() => {
      this.check();
    }, 300000);
    setTimeout(() => {
      this.check();
    }, 60000);
  }

  async check() {
    const hostManager = new HostManager();
    let dnsServers = [];
    const monitoringInterfaces = sysManager.getMonitoringInterfaces();
    for (const i of monitoringInterfaces) {
      const dns = (i.name && sysManager.myDNS(i.name) || []).concat(i.name && sysManager.myResolver(i.name) || []);
      for (let n of dns) {
        if (!dnsServers.includes(n))
          dnsServers.push(n);
      }
    }
    log.info("Current dns servers: ", dnsServers);
    const macEntries = await hostTool.getAllMACEntries();
    for (let i in macEntries) {
      const macEntry = macEntries[i];
      const ipv4Addr = macEntry.ipv4Addr;
      const ipv6Addrs = macEntry.ipv6Addr && JSON.parse(macEntry.ipv6Addr) || [];
      let disableDnsCaching = false;
      if (ipv4Addr && dnsServers.includes(ipv4Addr)) {
        log.info(`Device ${macEntry.mac} has ip address ${ipv4Addr}, which is dns server.`);
        disableDnsCaching = true;
      }
      for (const ipv6Addr of ipv6Addrs) {
        if (dnsServers.includes(ipv6Addr)) {
          log.info(`Device ${macEntry.mac} has ipv6 address ${ipv6Addr}, which is dns server.`);
          disableDnsCaching = true;
          break;
        }
      }

      if (disableDnsCaching) {
        const host = await hostManager.getHostAsync(macEntry.mac).catch((err) => null);
        if (host != null) {
          // double-check if dns upstream-related feature is enabled on this host, e.g., doh, family, unbound. If enabled, no need to turn off dns booster on this host
          const data = await host.loadPolicyAsync().catch((err) => {
            log.error("Failed to load policy of " + macEntry.mac, err.message);
            return null;
          });
          if (data) {
            if (_.isObject(data.doh) && data.doh.state === true) {
              log.info(`Device ${macEntry.mac} is using doh as DNS upstream, no need to turn off dns booster on it`);
              continue;
            }
            if (data.family === true) {
              log.info(`Device ${macEntry.mac} is using family protect as DNS upstream, no need to turn off dns booster on it`);
              continue;
            }
            if (_.isObject(data.unbound) && data.unbound.state === true) {
              log.info(`Device ${macEntry.mac} is using unbound as DNS upstream, no need to turn off dns booster on it`);
              continue;
            }
            log.info(`Going to turn off dns booster on ${macEntry.mac} ...`);
            const oldValue = (data && data['dnsmasq']) || {};
            const newValue = Object.assign({}, oldValue, { dnsCaching: false });
            await host.setPolicyAsync('dnsmasq', newValue).catch((err) => {
              log.error("Failed to disable dns caching on " + macEntry.mac);
            });
          }
        }
      }
    }
  }
}

module.exports = DnsLoopAvoidanceSensor;