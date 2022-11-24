/*    Copyright 2016 Firewalla LLC
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

const log = require('../net2/logger.js')(__filename, 'info');

const Hook = require('./Hook.js');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const util = require('util');

const fc = require('../net2/config.js');

const Constants = require('../net2/Constants.js');
const Message = require('../net2/Message.js');

class VPNHook extends Hook {
  constructor() {
    super();
  }

  run() {
    sem.on(Message.MSG_OVPN_CONN_ACCEPTED, (event) => {
      this._processEvent(event);
    });
    sem.on(Message.MSG_WG_CONN_ACCEPTED, (event) => {
      this._processEvent(event);
    });
  }

  _processEvent(event) {
    const remoteIP = event.client.remoteIP;
    const peerIP4 = event.client.peerIP4;
    const peerIP6 = event.client.peerIP6;
    const profile = event.client.profile;
    const vpnType = event.client.vpnType || Constants.VPN_TYPE_OVPN;
    log.info(util.format("A new VPN client is connected, remote: %s, vpn type: %s, peer ipv4: %s, peer ipv6: %s, profile: %s", remoteIP, vpnType, peerIP4, peerIP6, profile));
    this.createAlarm(remoteIP, peerIP4, peerIP6, profile, vpnType, "vpn_client_connection");
  }

  createAlarm(remoteIP, peerIP4, peerIP6, profile, vpnType = Constants.VPN_TYPE_OVPN, type) {
    type = type || "vpn_client_connection";

    if (!fc.isFeatureOn(type)) {
      log.info(util.format("Alarm type %s is not enabled in config.", type));
      return;
    }

    const Alarm = require('../alarm/Alarm.js');
    const AM2 = require('../alarm/AlarmManager2.js');
    const am2 = new AM2();

    const alarmPayload = {
      "p.dest.id": remoteIP,
      "p.dest.ip": remoteIP,
      "p.vpnType": vpnType
    };

    switch (vpnType) {
      case Constants.VPN_TYPE_OVPN:
        alarmPayload["p.dest.ovpn.peerIP4"] = peerIP4;
        alarmPayload["p.dest.ovpn.peerIP6"] = peerIP6;
        alarmPayload["p.dest.ovpn.profile"] = profile;
        const VPNProfile = require('../net2/identity/VPNProfile.js');
        alarmPayload["p.device.mac"] = `${VPNProfile.getNamespace()}:${profile}`;
        break;
      case Constants.VPN_TYPE_WG:
        alarmPayload["p.dest.wg.peerIP4"] = peerIP4;
        alarmPayload["p.dest.wg.peerIP6"] = peerIP6;
        alarmPayload["p.dest.wg.peer"] = profile;
        const WGPeer = require('../net2/identity/WGPeer.js');
        alarmPayload["p.device.mac"] = `${WGPeer.getNamespace()}:${profile}`;
        break;
      default:
    }

    if (type === "vpn_client_connection") {
      const alarm = new Alarm.VPNClientConnectionAlarm(new Date() / 1000,
        remoteIP,
        alarmPayload);
      am2.enqueueAlarm(alarm);
    }
  }
}

module.exports = VPNHook;