/*    Copyright 2016-2021 Firewalla Inc.
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
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Sensor = require('./Sensor.js').Sensor;
const Message = require('../net2/Message.js');
const {Address4, Address6} = require('ip-address');
const sclient = require('../util/redis_manager.js').getSubscriptionClient();

class OvpnConnSensor extends Sensor {
  run() {
    sclient.on("message", (channel, message) => {
      switch (channel) {
        case Message.MSG_OVPN_CLIENT_CONNECTED: {
          try {
            const [cn, remoteIP4, remoteIP6, remotePort, peerIP4, peerIP6] = message.split(",", 6);
            if (remoteIP4 && new Address4(remoteIP4).isValid() || remoteIP6 && new Address6(remoteIP6).isValid()) {
              log.info(`OpenVPN client connection accepted, remote: ${remoteIP4 || remoteIP6}, peer ipv4: ${peerIP4}, peer ipv6: ${peerIP6}, common name: ${cn}`);
              const event = {
                type: Message.MSG_OVPN_CONN_ACCEPTED,
                message: "A new VPN connection was accepted",
                client: {
                  remoteIP: remoteIP4 || remoteIP6,
                  remotePort: remotePort,
                  peerIP4: peerIP4,
                  peerIP6: peerIP6,
                  profile: cn
                }
              };
              sem.sendEventToAll(event);
              sem.emitLocalEvent(event);
            }
          } catch (err) {
            log.error(`Failed to process OpenVPN client connected message`, err);
          }
          break;
        }
        default:
      }
    });

    sclient.subscribe(Message.MSG_OVPN_CLIENT_CONNECTED);
  }
}

module.exports = OvpnConnSensor;
