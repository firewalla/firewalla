/*    Copyright 2022 Firewalla Inc.
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
'use strict'

const log = require('../net2/logger.js')(__filename);
const { Address4, Address6 } = require('ip-address');

class CategoryEntry {
  static parse(item) {
    const entries = [];
    const entry = {};
    const tokens = item.split(":");
    let idproto;
    let portinfo;
    if (tokens.length > 2 && item[0] !== '[') {
      // ipv6 address without port info
      idproto = item;
      portinfo = "";
    } else if (tokens.length > 2 && item[0] === '[') {
      // ipv6 address with port info
      idproto = tokens.slice(0, tokens.length - 1).join(":");
      portinfo = tokens[tokens.length - 1];
    } else if (tokens.length === 2) {
      // ipv4 address/domain with port info
      idproto = tokens[0];
      portinfo = tokens[1];
    } else {
      // ipv4 address/domain without port info
      idproto = item;
      portinfo = "";
    }

    let [id, proto] = idproto.split(",", 2);

    if (!id) {
      throw new Error(`Invalid entry`);
    }

    if (id[0] === '[' && id[id.length - 1] === ']') {
      id = id.slice(1, id.length - 1);
    }

    // parse type
    let type;
    let ipv4Addr = new Address4(id);
    if (ipv4Addr.isValid()) {
      if (ipv4Addr.subnetMask === 0) {
        throw new Error("ipv4 subnet mask cannot be 0");
      }
      type = "ipv4";
    } else {
      let ipv6Addr = new Address6(id);
      if (ipv6Addr.isValid()) {
        if (ipv6Addr.subnetMask === 0) {
          throw new Error("ipv6 subnet mask cannot be 0");
        }
        type = "ipv6";
      } else {
        type = "domain";
      }
    }
    entry.type = type;
    entry.id = id;

    if (proto && !["tcp", "udp"].includes(proto)) {
      throw new Error("Invalid protocol");
    }

    if (portinfo) {
      const portList = [];
      for (const port of portinfo.split(",")) {
        const [portStartStr, portEndStr, ...extra] = port.split("-");
        if (extra.length !== 0) {
          throw new Error("Invalid port format");
        }
        const startPort = this.validatePort(portStartStr);
        if (startPort === null) {
          throw new Error("Invalid port format");
        }
        let endPort;
        if (portEndStr) {
          endPort = this.validatePort(portEndStr);
          if (endPort === null || endPort < startPort) {
            throw new Error("Invalid port format");
          }
        } else {
          endPort = startPort;
        }
        if (proto) {
          portList.push({
            proto: proto,
            start: startPort,
            end: endPort
          });
        } else {
          portList.push({
            proto: "tcp",
            start: startPort,
            end: endPort
          });
          portList.push({
            proto: "udp",
            start: startPort,
            end: endPort
          });
        }
      }

      // break up port list items according to domain only ports that can be covered by tls kernel module; for example, tcp:440-450 will break into 3 entries: tcp:440-442, tcp:443, tcp:444-450. tcp:443 will be domain-only.
      const domainOnlyPorts = [80, 443, 853];
      domainOnlyPorts.sort((a, b) => a - b);

      for (const portObj of portList) {
        let startPort = portObj.start;
        let endPort = portObj.end;
        let proto = portObj.proto;
        if (proto === "udp") {
          entries.push(this.composeEntry(entry, portObj, false));
        } else if (proto === "tcp") {
          while (true) {
            let hit = false;
            for (const tlsPort of domainOnlyPorts) {
              if (tlsPort >= startPort && tlsPort <= endPort) {
                hit = true;
                if (startPort < tlsPort) {
                  entries.push(this.composeEntry(entry, { start: startPort, end: tlsPort - 1, proto: "tcp" }, false));
                }
                entries.push(this.composeEntry(entry, { start: tlsPort, end: tlsPort, proto: "tcp" }, true));
                startPort = tlsPort + 1;
                break;
              }
            }
            if (!hit) {
              if (endPort >= startPort) {
                entries.push(this.composeEntry(entry, { start: startPort, end: endPort, proto: "tcp" }, false));
              }
              break;
            }
          }
        }
      }
    } else {
      entries.push(this.composeEntry(entry));
    }

    return entries;
  }

  static composeEntry(entry, portObj, domainOnly) {
    const result = JSON.parse(JSON.stringify(entry));
    if (portObj) {
      result.port = portObj;
      result.pcount = portObj.end - portObj.start + 1;
      result.domainOnly = domainOnly;
    } else {
      result.pcount = 0;
    }
    return result;
  }

  static validatePort(portStr) {
    if (!portStr) {
      return null;
    }
    const portNum = Number(portStr);
    if (!portNum || !Number.isInteger(portNum)) {
      return null;
    }
    if (portNum >= 0 && portNum <= 65535) {
      return portNum;
    } else {
      return null;
    }
  }

  static toPortStr(portObj) {
    if (portObj.start === portObj.end) {
      return `${portObj.proto}:${portObj.start}`;
    } else {
      return `${portObj.proto}:${portObj.start}-${portObj.end}`;
    }
  }
}

module.exports = {
  CategoryEntry
};