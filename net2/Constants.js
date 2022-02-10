/*    Copyright 2020-2021 Firewalla Inc.
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

// NS: namespace
module.exports = {
  NS_VPN_PROFILE : "vpn_profile",
  NS_WG_PEER: "wg_peer",
  NS_INTERFACE : "if",
  RULE_SEQ_HI : 1,
  RULE_SEQ_REG : 2,
  RULE_SEQ_LO : 3,
  DEFAULT_VPN_PROFILE_CN : "fishboneVPN1",

  VPN_TYPE_OVPN : "ovpn",
  VPN_TYPE_WG: "wg",

  TRUST_IP_SET: "trust:ip",
  TRUST_DOMAIN_SET: "trust:domain",

  REDIS_KEY_EID_REVOKE_SET: "sys:ept:members:revoked",
  REDIS_KEY_GROUP_NAME: "groupName"
};
