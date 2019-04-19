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

class VPNHook extends Hook {
  constructor() {
    super();
  }

  run() {
    sem.on("VPNConnectionAccepted", (event) => {
      const remoteIP = event.client.remoteIP;
      const remotePort = event.client.remotePort;
      const peerIP4 = event.client.peerIP4;
      const peerIP6 = event.client.peerIP6;
      const profile = event.client.profile;
      log.info(util.format("A new VPN client is connected, remote: %s:%s, peer ipv4: %s, peer ipv6: %s, profile: %s", remoteIP, remotePort, peerIP4, peerIP6, profile));
      this.createAlarm(remoteIP, remotePort, peerIP4, peerIP6, profile, "vpn_client_connection");
    });
  }

  createAlarm(remoteIP, remotePort, peerIP4, peerIP6, profile, type) {
    type = type || "vpn_client_connection";

    if (!fc.isFeatureOn(type)) {
      log.info(util.format("Alarm type %s is not enabled in config.", type));
      return;
    }

    const Alarm = require('../alarm/Alarm.js');
    const AM2 = require('../alarm/AlarmManager2.js');
    const am2 = new AM2();

    const name = remoteIP + ":" + remotePort;

    if (type === "vpn_client_connection") {
      const alarm = new Alarm.VPNClientConnectionAlarm(new Date() / 1000,
                                                name,
                                                {
                                                  "p.dest.id": name,
                                                  "p.dest.ip": remoteIP,
                                                  "p.dest.port": remotePort,
                                                  "p.dest.ovpn.peerIP4": peerIP4,
                                                  "p.dest.ovpn.peerIP6": peerIP6,
                                                  "p.dest.ovpn.profile": profile
                                                });
      am2.enqueueAlarm(alarm);
    }
  }
}

module.exports = VPNHook;