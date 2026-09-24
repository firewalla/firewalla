/*    Copyright 2016-2026 Firewalla Inc.
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

// Pure helpers for building the network topology path in /v1/me.
// Kept free of heavy runtime dependencies so they can be unit tested standalone.

function normalizeMac(mac) {
  return (mac || '').toUpperCase();
}

// depth-first search for the tree node matching mac, returns the path from root to the node (inclusive)
function findPathByMac(nodes, mac) {
  for (const node of nodes || []) {
    if (normalizeMac(node.mac) === normalizeMac(mac)) {
      return [node];
    }
    if (Array.isArray(node.children) && node.children.length) {
      const found = findPathByMac(node.children, mac);
      if (found) return [node].concat(found);
    }
  }
  return null;
}

function buildHops(path) {
  return path.map((node, index) => {
    const isWireless = node.connectionType === 'wireless';
    return {
      isDevice: index === path.length - 1,
      type: node.type,
      name: node.name || node.mac,
      mac: node.mac,
      ip: node.ip || null,
      connectionType: node.connectionType || null,
      isWireless,
      uplinkPort: node.child_port || null,
      parentPort: node.parent_port || null,
      ssid: isWireless ? (node.ssid || null) : null,
      band: isWireless ? (node.band || null) : null,
      rssi: isWireless && node.rssi != null ? node.rssi : null,
      channel: null,
      latency: null,
    };
  });
}

module.exports = {
  normalizeMac,
  findPathByMac,
  buildHops,
};
