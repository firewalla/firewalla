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

const log = require('../net2/logger.js')(__filename);
const util = require('util');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Tail = require('always-tail');
const fs = require('fs');
const cp = require('child_process');
const Sensor = require('./Sensor.js').Sensor;

class OvpnConnSensor extends Sensor {
  constructor() {
    super();
  }

  initLogWatcher() {
    if (!fs.existsSync(this.config.logPath)) {
      log.warn(util.format("Log file %s does not exist, awaiting for file creation.", this.config.logPath));
      setTimeout(() => {
        this.initLogWatcher();
      }, 5000);
    } else {
      // add read permission in case it is owned by root
      const cmd = util.format("sudo chmod +r %s", this.config.logPath);
      cp.exec(cmd, (err, stdout, stderr) => {
        if (err || stderr) {
          log.error(util.format("Failed to change permission for log file: %s", err || stderr));
          setTimeout(() => {
            this.initLogWatcher();
          }, 5000);
          return;
        }
        if (this.ovpnLog == null) {
          log.debug("Initializing ovpn log watchers: ", this.config.logPath);
          this.ovpnLog = new Tail(this.config.logPath, '\n');
          if (this.ovpnLog != null) {
            this.ovpnLog.on('line', (data) => {
              log.debug("Detect:OvpnLog ", data);
              this.processOvpnLog(data);
            });
          } else {
            setTimeout(() => {
              this.initLogWatcher();
            }, 5000);
          }
        }
      });
    }
  }

  run() {
    this.initLogWatcher();
  }

  processOvpnLog(data) {
    if (data.includes(": pool returned")) {
      // vpn client connection accepted
      const words = data.split(/\s+/, 6);
      const remote = words[5];
      const peers = data.substr(data.indexOf('pool returned') + 14);
      // remote should be <name>/<ip>:<port>
      const profile = remote.split('/')[0];
      const client = remote.split('/')[1];
      const clientIP = client.split(':')[0];
      const clientPort = client.split(':')[1];
      // peerIP4 should be IPv4=<ip>,
      const peerIP4 = peers.split(', ')[0];
      let peerIPv4Address = peerIP4.split('=')[1];
      if (peerIPv4Address === "(Not enabled)") {
        peerIPv4Address = null;
      }
      // peerIP6 should be IPv6=<ip>
      const peerIP6 = peers.split(', ')[1];
      let peerIPv6Address = peerIP6.split('=')[1];
      if (peerIPv6Address === "(Not enabled)") {
        peerIPv6Address = null;
      }
      log.info(util.format("VPN client connection accepted, remote: %s, peer ipv4: %s, peer ipv6: %s, profile: %s", client, peerIPv4Address, peerIPv6Address, profile));
      sem.emitEvent({
        type: "VPNConnectionAccepted",
        message: "A new VPN connection was accepted",
        client: {
          remoteIP: clientIP,
          remotePort: clientPort,
          peerIP4: peerIPv4Address,
          peerIP6: peerIPv6Address,
          profile: profile
        }
      });
    }
  }
}

module.exports = OvpnConnSensor;