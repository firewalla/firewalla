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

const sysManager = require('../../net2/SysManager.js');
const { Address4 } = require('ip-address');

// resolve the CIDR subnet(s) of the box network the device ip belongs to.
// box networks are cached in sysManager, sourced from fwapc GET /v1/config/active,
// so this honours any valid prefix length (/16, /23, /25, ...) rather than a /24 guess.
function deviceSubnets(deviceIp) {
  const intf = sysManager.getInterfaceViaIP4(deviceIp, false);
  if (intf && Array.isArray(intf.ip4_subnets) && intf.ip4_subnets.length) return intf.ip4_subnets;
  if (intf && intf.subnet) return [intf.subnet];
  return [];
}

function isValidIp4(ip) {
  return typeof ip === 'string' && new Address4(ip).isValid();
}

// the AP address (from fwapc /status/ap addrs) within the device's own subnet, or null.
// callers pick their own fallback
function apIpInDeviceSubnet(addrs, deviceIp) {
  const subnets = deviceSubnets(deviceIp).map(s => new Address4(s)).filter(s => s.isValid());
  if (!subnets.length) return null;
  // only keep syntactically valid ipv4 candidates
  const ips = Object.values(addrs || {}).map(a => a && a.ip4).filter(isValidIp4);
  return ips.find(ip => subnets.some(s => new Address4(ip).isInSubnet(s))) || null;
}

module.exports = {
  deviceSubnets,
  isValidIp4,
  apIpInDeviceSubnet,
};
