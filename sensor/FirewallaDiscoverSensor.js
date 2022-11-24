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
const util = require('util');
const dgram = require('dgram');
const ip = require('ip');
const sysManager = require('../net2/SysManager.js');

const Sensor = require('./Sensor.js').Sensor;

class FirewallaDiscoverSensor extends Sensor {
  constructor(config) {
    super(config);
    this.ip = sysManager.myIp();
    this.subnet = sysManager.mySubnet();
    this.cidr = ip.cidrSubnet(this.subnet);
  }
  
  _getPongResponse() {
    return util.format("pong %s", this.ip);
  }

  run() {
    const socket = dgram.createSocket('udp4');
    const port = this.config.listenPort || 4096;

    socket.on('listening', () => {
      socket.setBroadcast(true);
      setInterval(() => {
        const broadcastAddr = this.cidr.broadcastAddress;
        log.debug("Ping " + broadcastAddr);
        socket.send("ping", port, broadcastAddr);
      }, 60 * 1000);
    });

    socket.on('message', (message, info) => {
      if (message.toString() === "ping") {
        log.debug(util.format("Received ping request from %s:%d", info.address, info.port));
        if (info.address === this.ip) {
          log.debug("Ignore ping request from localhost");
        } else {
          const response = this._getPongResponse();
          socket.send(response, info.port, info.address);
        }
      }
      if (message.toString() === "pong") {
        log.info(util.format("Received pong response from %s:%d", info.address, info.port));
        // Another firewalla box might be found in the same subnet. Further actions can be applied, e.g., generate notification?
      }
    });

    socket.on('error', (err) => {
      log.error("Got error when discover sensor socket:", err);
    });

    socket.bind(port, "0.0.0.0");
  }
}

module.exports = FirewallaDiscoverSensor;