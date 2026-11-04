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

/*
 * WANRING, Sending Event Disabled until everything is hooked up
 */

'use strict';

const asyncNative = require('../util/asyncNative.js');

const log = require('../net2/logger.js')(__filename);

const sem = require('../sensor/SensorEventManager.js').getInstance();

const Sensor = require('./Sensor.js').Sensor;
const sysManager = require('../net2/SysManager.js');
const { exec: execAsync, execFile } = require('child-process-promise')

const SCAN_INTERVAL = 1000 * 60 * 15;
const NUD_STATES = ['PERMANENT', 'NOARP', 'REACHABLE', 'STALE', 'DELAY', 'PROBE', 'INCOMPLETE', 'FAILED', 'NONE'];

class IPv6DiscoverySensor extends Sensor {
  constructor(config) {
    super(config);
    this.enabled = true; // very basic feature, always enabled
    this.previousScan = null; // read time and neighbors of the last successful read
    let p = require('../net2/MessageBus.js');
    this.publisher = new p('info', 'Scan:Done', 10);
  }

  run() {
    setTimeout(() => {
      this.checkAndRunOnce(true);

      setInterval(() => {
        this.checkAndRunOnce(true);
      }, SCAN_INTERVAL); // every 15 minutes, fast scan, it is reduced from 5 minutes to 15 minutes because nmap scan is no longer essential for device discovery, we already have flow, ARPSensor, DHCPSensor, and ICMP6Sensor

    }, 1000 * 60 * 5); // start the first run in 5 minutes
  }

  async checkAndRunOnce() {
    if (this.isSensorEnabled()) {
      log.info("Starting Scanning");
      await this.neighborDiscoveryV6();
    }
  }

  isSensorEnabled() {
    return this.enabled;
  }

  // e.g. "2001:db8::10 dev br0 lladdr 00:00:5e:00:53:10 router used 315/315/315 probes 1 REACHABLE"
  static parseNeighbor(line) {
    const parts = line.trim().split(/\s+/);
    const after = (key) => {
      const i = parts.indexOf(key);
      return i >= 0 && i + 1 < parts.length ? parts[i + 1] : null;
    };
    const mac = after('lladdr');
    const state = parts.filter(part => NUD_STATES.includes(part)).pop() || null; // "proto <name>" may follow the state
    if (!mac || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(mac) || state === 'FAILED' || state === 'INCOMPLETE')
      return null;
    // seconds since last used/confirmed/updated, newer iproute2 prints no space before "probes"
    const ages = line.match(/\bused (\d+)\/(\d+)\/(\d+)/);
    return {
      ip6: parts[0], intf: after('dev'), mac: mac.toUpperCase(), state,
      confirmed: ages ? Number(ages[2]) : undefined,
      updated: ages ? Number(ages[3]) : undefined,
    };
  }

  static neighborKey(entry) {
    return `${entry.intf}|${entry.ip6}|${entry.mac}`;
  }

  // seen in the last maxAge seconds: confirmed, or updated and new since the previous scan,
  // as the kernel also updates an entry when it ages from REACHABLE to STALE
  static isRecent(entry, previousKeys, maxAge) {
    if (entry.state === 'PERMANENT')
      return true;
    if (entry.confirmed === undefined && entry.updated === undefined) // no ages, judge by state
      return ['REACHABLE', 'DELAY', 'PROBE'].includes(entry.state);
    if (entry.confirmed <= maxAge)
      return true;
    const isNew = !previousKeys || !previousKeys.has(IPv6DiscoverySensor.neighborKey(entry));
    return isNew && entry.updated <= maxAge;
  }

  // monotonic, in ms
  now() {
    const [s, ns] = process.hrtime();
    return s * 1000 + ns / 1e6;
  }

  async ping6ForDiscovery(intf, obj) {
    await execFile("ping6", ["-c2", "-w5", "-I", intf, `ff02::1%${intf}`], { timeout: 6000 }).catch((err) => { });
    return asyncNative.eachLimit(obj.ip6_addresses, 5, async (o) => {
      let pcmd = `ping6 -B -c 2 -w5 -I ${intf} -I ${o} ff02::1%${intf}`;
      log.debug("Discovery:v6Neighbor:Ping6", pcmd);
      return execAsync(pcmd, { timeout: 6000 }).catch((err) => { });
    })
  }


  addV6Host(v6addrs, mac, intf) {
    sem.emitEvent({
      type: "DeviceUpdate",
      message: `A new ipv6 is found @ IPv6DisocverySensor ${v6addrs} ${mac}`,
      host: {
        ipv6Addr: v6addrs,
        mac: mac.toUpperCase(),
        intf_mac: intf.mac_address,
        intf_uuid: intf.uuid,
        from: "ip6neighbor"
      },
      suppressEventLogging: true,
    });
  }

  async neighborDiscoveryV6() {
    const interfaces = sysManager.getMonitoringInterfaces();
    for (const intf of interfaces) {
      if (intf.ip6_addresses == null || intf.ip6_addresses.length <= 1) {
        log.debug("Discovery:v6Neighbor:NoV6", intf.name, JSON.stringify(intf));
        continue;
      }
      await this.ping6ForDiscovery(intf.name, intf);
    }
    const cmdline = 'ip -6 -s neighbor show';
    log.verbose("Running commandline: ", cmdline);
    const readAt = this.now();
    const { stdout } = await execAsync(cmdline)
    const entries = stdout.split("\n").map(line => IPv6DiscoverySensor.parseNeighbor(line)).filter(Boolean);
    // back to the previous successful read, one interval for the first
    const maxAge = this.previousScan ? Math.ceil((readAt - this.previousScan.at) / 1000) : SCAN_INTERVAL / 1000;
    const previousKeys = this.previousScan && this.previousScan.keys;
    for (const intf of interfaces) {
      let macHostMap = {};
      for (const entry of entries) {
        if (entry.intf !== intf.name || !IPv6DiscoverySensor.isRecent(entry, previousKeys, maxAge))
          continue;
        log.debug("Discover:v6Neighbor:Scan:Entry", entry.ip6, entry.mac, "of interface", intf.name);
        let _host = macHostMap[entry.mac];
        if (_host) {
          _host.push(entry.ip6);
        } else {
          _host = [entry.ip6];
          macHostMap[entry.mac] = _host;
        }
      }
      for (let mac in macHostMap) {
        this.addV6Host(macHostMap[mac], mac, intf);
      }
    }
    this.previousScan = { at: readAt, keys: new Set(entries.map(entry => IPv6DiscoverySensor.neighborKey(entry))) };

    // FIXME
    // This is a very workaround activity to send scan done out in 5 seconds
    // several seconds is necessary to ensure new ip addresses are added
    setTimeout(() => {
      log.info("IPv6 Scan:Done");
      // Scan:Done message will be emiited in NmapSensor
      // this.publisher.publishCompressed("DiscoveryEvent", "Scan:Done", '0', {});
    }, 5000)

  }

  isSensorEnable() {
    return Promise.resolve(this.enabled);
  }

}

module.exports = IPv6DiscoverySensor;
