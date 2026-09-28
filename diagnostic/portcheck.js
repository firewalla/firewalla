/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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

const util = require('util');
const cp = require('child_process');
const log = require('../net2/logger.js')(__filename, 'info');

const execAsync = util.promisify(cp.exec);

const TCP = "tcp";
const UDP = "udp";
const PROTOCOLS = [TCP, UDP];
const BOTH = PROTOCOLS;

// iperf (10001-20000 random) and zeek (dynamic ZeekPort) are not listed here, covered by runtime check
const RESERVED_PORTS = [
  { start: 0, end: 1023, protocols: BOTH, usage: "system" },
  { start: 1194, end: 1194, protocols: BOTH, usage: "openvpn server" },
  { start: 5194, end: 5194, protocols: BOTH, usage: "openvpn server" },
  { start: 1812, end: 1813, protocols: BOTH, usage: "radius service" },
  { start: 18120, end: 18121, protocols: BOTH, usage: "radius service" },
  { start: 5350, end: 5351, protocols: BOTH, usage: "upnp service" },
  { start: 5353, end: 5353, protocols: BOTH, usage: "mdns service" },
  { start: 6379, end: 6379, protocols: [TCP], usage: "redis service" },
  { start: 6666, end: 6666, protocols: [TCP], usage: "firerouter internal socket" },
  { start: 8833, end: 8834, protocols: [TCP], usage: "firewalla service" },
  { start: 18833, end: 18833, protocols: [TCP], usage: "firewalla service" },
  { start: 8837, end: 8837, protocols: [TCP], usage: "firewalla service" },
  { start: 8838, end: 8839, protocols: [TCP], usage: "firewalla service" },
  { start: 8839, end: 8839, protocols: [UDP], usage: "fwapc service" },
  { start: 8841, end: 8841, protocols: [TCP], usage: "firewalla service" },
  { start: 8843, end: 8843, protocols: [TCP], usage: "firewalla service" },
  { start: 8853, end: 8853, protocols: BOTH, usage: "firewalla service" },
  { start: 8854, end: 8854, protocols: BOTH, usage: "firewalla service" },
  { start: 8866, end: 8866, protocols: [UDP], usage: "fwapc service" },
  { start: 8869, end: 8869, protocols: [UDP], usage: "fwapc service" },
  { start: 8953, end: 8953, protocols: BOTH, usage: "firewalla service" },
  { start: 9053, end: 9053, protocols: BOTH, usage: "firewalla service" },
  { start: 9227, end: 9229, protocols: [TCP], usage: "firewalla service" },
  { start: 9964, end: 9964, protocols: [TCP], usage: "firewalla service" },
  { start: 9966, end: 9966, protocols: [TCP], usage: "firewalla service" }
];

let instance = null;

class PortChecker {
  constructor() {
    if (instance === null)
      instance = this;
    return instance;
  }

  async checkPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid port " + value + ", expect an integer between 1 and 65535");

    const result = { port: port };
    const checks = PROTOCOLS.map(async (protocol) => {
      const reserved = RESERVED_PORTS.find(e =>
        e.protocols.includes(protocol) && port >= e.start && port <= e.end
      );
      if (reserved) {
        result[protocol] = { status: "reserved", usage: reserved.usage };
        return;
      }
      try {
        const listeningPorts = await this._getListeningPorts(protocol);
        result[protocol] = { status: listeningPorts.has(port) ? "in_use" : "available" };
      } catch (err) {
        // a failed live probe on one protocol must not discard a known-good answer on the other
        result[protocol] = { status: "unknown" };
      }
    });
    await Promise.all(checks);
    if (PROTOCOLS.every(protocol => result[protocol].status === "unknown"))
      throw new Error("Unable to check port " + port);
    return result;
  }

  async _getListeningPorts(protocol) {
    const flag = protocol === UDP ? "-u" : "-t";
    const cmd = "ss -n -l " + flag;
    let stdout = null;
    try {
      stdout = (await execAsync(cmd)).stdout;
    } catch (err) {
      log.error("Failed to list listening " + protocol + " sockets", err.message);
      throw new Error("Unable to check " + protocol + " ports");
    }

    const ports = new Set();
    for (const line of stdout.split("\n")) {
      for (const token of line.trim().split(/\s+/)) {
        const matched = token.match(/:(\d+)$/);
        if (!matched)
          continue;
        ports.add(Number(matched[1]));
        break;
      }
    }
    return ports;
  }
}

module.exports = new PortChecker();
