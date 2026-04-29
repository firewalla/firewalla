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

const log = require('../net2/logger.js')(__filename);
const WgvpnConnSensor = require('./WgvpnConnSensor.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const _ = require('lodash');
const {Address4, Address6} = require('ip-address');
const Constants = require('../net2/Constants.js');
const Message = require('../net2/Message.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

const peerLastEndpointMap = {};

const CHECK_INTERVAL = 20;

class AmneziaWgConnSensor extends WgvpnConnSensor {

  constructor(config) {
    super(config);
    this.wgCmd = `${platform.getPlatformFilesPath()}/awg`;
    this.protocol = "amneziawg";
  }

  isSupported() {
    return platform.isAmneziaWgSupported();
  }

  getRedisKeyVPNWGPeer() {
    return Constants.REDIS_KEY_VPN_AMNEZIAWG_PEER;
  }

  getConnAcceptedMessageType() {
    return Message.MSG_AMNEZIAWG_CONN_ACCEPTED;
  }

  getVpnType() {
    return Constants.VPN_TYPE_AMNEZIAWG;
  }

}

module.exports = AmneziaWgConnSensor;
