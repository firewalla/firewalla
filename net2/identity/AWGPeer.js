/*    Copyright 2021-2025 Firewalla Inc.
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

const log = require('../logger.js')(__filename);
const PlatformLoader = require('../../platform/PlatformLoader.js');
const platform = PlatformLoader.getPlatform();
const Constants = require('../Constants.js');
const WGPeer = require('./WGPeer.js');
const Message = require('../Message.js');
const _ = require('lodash');

class AWGPeer extends WGPeer {

  static wgPeers = {};
  static privPubKeyMap = {};
  static wgCmd() {
    return `${platform.getPlatformFilesPath()}/awg`;
  }
  
  static isEnabled() {
    return platform.isAmneziaWgSupported();
  }

  static getNamespace() {
    return Constants.NS_AMNEZIAWG_PEER;
  }

  static getKeyOfUIDInAlarm() {
    return "p.device.awgPeer";
  }

  static getKeyOfInitData() {
    return "awgPeers";
  }

  static getProtocol() {
    return "amneziawg";
  }

  static getRedisKeyVPNWGPeer() {
    return Constants.REDIS_KEY_VPN_AMNEZIAWG_PEER;
  }

  static getRefreshIdentitiesHookEvents() {
    return [Message.MSG_SYS_NETWORK_INFO_RELOADED, Message.MSG_AMNEZIAWG_PEER_REFRESHED];
  }

  static getRefreshIPMappingsHookEvents() {
    return [Message.MSG_AMNEZIAWG_CONN_ACCEPTED];
  }

  getLocalizedNotificationKeySuffix() {
    const obj = this.toJson();
    return `.vpn.${_.isArray(obj.allowedIPs) && obj.allowedIPs.length > 1 ? "s2s" : "cs"}.awgvpn`;
  }
  
}

module.exports = AWGPeer;