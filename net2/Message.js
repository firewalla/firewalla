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

const MSG_NETWORK_CHANGED = "System:network_changed";
const MSG_SYS_NETWORK_INFO_UPDATED = "System:network_info_updated";
const MSG_SYS_NETWORK_INFO_RELOADED = "System:network_info_reloaded";
const MSG_FW_FR_RELOADED = "firewalla.firerouter.reloaded";
const MSG_FR_CHANGE_APPLIED = "firerouter.change_applied";
const MSG_FR_IFACE_CHANGE_APPLIED = "firerouter.iface_change_applied";
const MSG_SYS_API_INTERFACE_CHANGED = "System:api:interface_changed";
const MSG_SECONDARY_IFACE_UP = "System:secondary_interface:up";
const MSG_OVPN_CLIENT_ROUTE_UP = "ovpn_client.route_up";
const MSG_FR_WAN_CONN_CHANGED = "firerouter.wan_conn_changed";
const MSG_FR_WAN_STATE_CHANGED = "firerouter.wan_state_changed";
const MSG_PCAP_RESTART_NEEDED = "pcap_restart_needed";
const MSG_NEBULA_VPN_ROUTE_UPDATE = "nebula_vpn.route_update"

const MSG_SYS_TIMEZONE_RELOADED = "System:timezone_reloaded";

const MSG_ACL_DNS = "ACL:DNS";

const MSG_WG_SUBNET_CHANGED = "System:WGSubnetChanged";
const MSG_OVPN_CONN_ACCEPTED = "VPNConnectionAccepted";
const MSG_WG_CONN_ACCEPTED = "WGVPNConnectionAccepted";
const MSG_OVPN_PROFILES_UPDATED = "VPNProfiles:Updated";
const MSG_VIP_PROFILES_UPDATED = "VIPProfiles:Updated";
const MSG_WG_PEER_REFRESHED = "WG_PEER_REFRESHED";
const MSG_OVPN_CLIENT_CONNECTED = "ovpn.client_connected";

const MSG_VIRT_WAN_GROUP_UPDATED = "VWG_UPDATED";

const MSG_SYS_STATES_CHANNEL = 'sys:states:channel';

const MSG_FIRERESET_BLE_CONTROL_CHANNEL = 'firereset.ble.control';
const MSG_LICENSE_UPDATED = 'System:LicenceUpdated';

const MSG_OSI_MATCH_ALL_KNOB_OFF = 'osi:match_all_knob:off';
const MSG_OSI_VERIFIED= 'osi:verified';
const MSG_OSI_UPDATE_NOW = 'osi:update_now';

module.exports = {
  MSG_NETWORK_CHANGED,
  MSG_SYS_NETWORK_INFO_UPDATED,
  MSG_SYS_NETWORK_INFO_RELOADED,
  MSG_FW_FR_RELOADED,
  MSG_FR_CHANGE_APPLIED,
  MSG_FR_IFACE_CHANGE_APPLIED,
  MSG_SYS_API_INTERFACE_CHANGED,
  MSG_SECONDARY_IFACE_UP,
  MSG_OVPN_CLIENT_ROUTE_UP,
  MSG_SYS_TIMEZONE_RELOADED,
  MSG_ACL_DNS,
  MSG_FR_WAN_CONN_CHANGED,
  MSG_FR_WAN_STATE_CHANGED,
  MSG_PCAP_RESTART_NEEDED,
  MSG_WG_SUBNET_CHANGED,
  MSG_OVPN_CONN_ACCEPTED,
  MSG_WG_CONN_ACCEPTED,
  MSG_OVPN_PROFILES_UPDATED,
  MSG_VIP_PROFILES_UPDATED,
  MSG_WG_PEER_REFRESHED,
  MSG_OVPN_CLIENT_CONNECTED,
  MSG_SYS_STATES_CHANNEL,
  MSG_FIRERESET_BLE_CONTROL_CHANNEL,
  MSG_NEBULA_VPN_ROUTE_UPDATE,
  MSG_VIRT_WAN_GROUP_UPDATED,
  MSG_LICENSE_UPDATED,
  MSG_OSI_MATCH_ALL_KNOB_OFF,
  MSG_OSI_VERIFIED,
  MSG_OSI_UPDATE_NOW
}
