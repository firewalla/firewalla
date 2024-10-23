/*    Copyright 2020-2024 Firewalla Inc.
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
  NS_VPN_PROFILE: "vpn_profile",
  NS_WG_PEER: "wg_peer",
  NS_VIP_PROFILE: "vip",
  NS_INTERFACE: "if",
  RULE_SEQ_HI: 1,
  RULE_SEQ_REG: 2,
  RULE_SEQ_LO: 3,
  DEFAULT_VPN_PROFILE_CN: "fishboneVPN1",

  DNS_DEFAULT_WAN_TAG: "wan",

  VPN_TYPE_OVPN: "ovpn",
  VPN_TYPE_WG: "wg",

  TRUST_IP_SET: "trust:ip",
  TRUST_DOMAIN_SET: "trust:domain",

  REDIS_KEY_EID_REVOKE_SET: "sys:ept:members:revoked",
  REDIS_KEY_GROUP_NAME: "groupName",
  REDIS_KEY_DDNS_UPDATE: "ddns:update",
  REDIS_KEY_CPU_USAGE: "cpu_usage_records",
  REDIS_KEY_REDIS_KEY_COUNT: 'sys:redis:count',
  REDIS_KEY_LOCAL_DOMAIN_SUFFIX: "local:domain:suffix",
  REDIS_KEY_LOCAL_DOMAIN_NO_FORWARD: "local:domain:no_forward",
  REDIS_KEY_ETH_INFO: "sys:ethInfo",
  REDIS_KEY_APP_TIME_USAGE_APPS: "app_time_usage_apps",
  REDIS_KEY_APP_TIME_USAGE_CATEGORY: "app_time_usage_category",
  REDIS_KEY_POLICY_STATE: 'policy:state',
  REDIS_KEY_EXT_SCAN_RESULT: "sys:scan:external",
  REDIS_KEY_WEAK_PWD_RESULT: "sys:scan:weak_password",
  REDIS_KEY_NSE_RESULT: "sys:scan:nse",
  REDIS_KEY_NTP_SERVER_STATUS: "sys:ntp:status", // updated only when ntp_redirect is enabled
  REDIS_KEY_VPN_WG_PEER: 'vpn:wg:peer:', // vpn:wg:peer:{intf}:{pubkey}
  REDIS_KEY_APP_TIME_USAGE_CLOUD_CONFIG: "app_time_usage_cloud_config",
  REDIS_KEY_HISTORY_MSG_PREFIX: "_hx:msg:",

  REDIS_HKEY_NSE_DHCP: "dhcp",
  REDIS_HKEY_CONN_OINTF: "oIntf",
  REDIS_HKEY_CONN_HOST: "host",
  REDIS_HKEY_CONN_APID: "apid", // allow rule id
  REDIS_HKEY_CONN_RPID: "rpid", // route rule id

  ST_INIT: 'init',
  ST_PENDING: 'pending',
  ST_READY: 'ready',
  ST_ACTIVATED: 'active',
  ST_IGNORE: 'ignore',
  ST_TIMEOUT: 'timeout',

  SCRIPT_POST_INIT_PAIRING: "postInitPairing",
  SCRIPT_POST_FIRST_CHECKIN: "postFirstCheckin",

  NOTIF_CATEGORY_WEAK_PASSWORD_SCAN: "com.firewalla.category.weak_password_scan",

  STATE_EVENT_NIC_SPEED: "nic_speed",

  ACL_VPN_CLIENT_WAN_PREFIX: "VC:",
  ACL_VIRT_WAN_GROUP_PREFIX: "VWG:",

  WAN_TYPE_SINGLE: "single",
  WAN_TYPE_FAILOVER: "primary_standby",
  WAN_TYPE_LB: "load_balance",

  VC_INTF_PREFIX: "vpn_",

  TAG_TYPE_DEVICE: "device",
  TAG_TYPE_USER: "user",
  TAG_TYPE_GROUP: "group",

  TAG_TYPE_MAP: {
    device: {
      redisKeyPrefix: "deviceTag:uid:",
      initDataKey: "deviceTags",
      policyKey: "deviceTags",
      flowKey: "dTags",
      alarmIdKey: "p.dtag.ids",
      alarmNameKey: "p.dtag.names",
      ruleTagPrefix: "deviceTag:",
      needAppTimeInInitData: false,
    },
    user: {
      redisKeyPrefix: "userTag:uid:",
      initDataKey: "userTags",
      policyKey: "userTags",
      flowKey: "userTags",
      alarmIdKey: "p.utag.ids",
      alarmNameKey: "p.utag.names",
      ruleTagPrefix: "userTag:",
      needAppTimeInInitData: true,
    },
    group: {
      redisKeyPrefix: "tag:uid:",
      initDataKey: "tags",
      policyKey: "tags",
      flowKey: "tags",
      alarmIdKey: "p.tag.ids",
      alarmNameKey: "p.tag.names",
      ruleTagPrefix: "tag:",
      needAppTimeInInitData: false
    }
  },

  IPTABLES_LOG_PREFIX_AUDIT: '[FW_ADT]',

  HOST_MAC_KEY_EXPIRE_SECS: 86400 * 365,

  FEATURE_LOCAL_FLOW: "local_flow",
  FEATURE_VPN_DISCONNECT: "vpn_disconnect",
  FEATURE_VPN_RESTORE: "vpn_restore",
};
