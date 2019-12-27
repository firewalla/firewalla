/*    Copyright 2019 Firewalla Inc. 
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
const readline = require('readline');
const ip = require('ip');

const sem = require('../sensor/SensorEventManager.js').getInstance();

const Sensor = require('./Sensor.js').Sensor;
const SysManager = require('../net2/SysManager.js');
const Discovery = require('../net2//Discovery.js');
const networkTool = require('../net2/NetworkTool')();
const cp = require('child_process');
const execAsync = util.promisify(cp.exec);
const spawn = cp.spawn;

class ICMP6Sensor extends Sensor {
  constructor() {
    super();
    this.myMac = null;
    this.interfaces = null;
  }

  run() {
    (async () => {
      this.interfaces = await networkTool.getLocalNetworkInterface();
      for (const intf of this.interfaces) {
        if (!intf.name || !intf.mac_address) continue;
        // listen on icmp6 neighbor-advertisement which is not sent from firewalla
        const tcpdumpSpawn = spawn('sudo', ['tcpdump', '-i', intf.name, '-en', `!(ether src ${intf.mac_address}) && icmp6 && ip6[40] == 136`]);
        const pid = tcpdumpSpawn.pid;
        log.info("TCPDump icmp6 started with PID: ", pid);
        const reader = readline.createInterface({
          input: tcpdumpSpawn.stdout
        });
        reader.on('line', (line) => {
          this.processNeighborAdvertisement(line);
        });
        tcpdumpSpawn.on('close', (code) => {
          log.info("TCPDump icmp6 exited with code: ", code);
        })
      }
      if (!this.interfaces) {
        setTimeout(() => {
          log.info("Failed to get self MAC address from sysManager, retry in 60 seconds.");
          this.run();
        }, 60000);
        return;
      }
    })().catch((err) => {
      log.error("Failed to run ICMP6Sensor", err);
    });
  }

  processNeighborAdvertisement(line) {
    // Each line of neighbor advertisement is like:
    // 03:06:30.894621 00:0c:29:96:3c:30 > 02:01:f4:16:26:dc, ethertype IPv6 (0x86dd), length 78: 2601:646:8800:eb7:dc04:b1fa:d0c2:6cbb > fe80::1:f4ff:fe16:26dc: ICMP6, neighbor advertisement, tgt is 2601:646:8800:eb7:dc04:b1fa:d0c2:6cbb, length 24
    try {
      const infos = line.split(',');
      const dstMac = infos[0].split(' ')[1];
      const tgtIp = infos[4].substring(8); // omit ' tgt is '
      log.info("Neighbor advertisement detected: " + dstMac + ", " + tgtIp);
      if (dstMac && ip.isV6Format(tgtIp)) {
        sem.emitEvent({
          type: "DeviceUpdate",
          message: `A new ipv6 is found @ ICMP6Sensor ${tgtIp} ${dstMac}`,
          suppressAlarm: true,
          host: {
            ipv6Addr: [tgtIp],
            mac: dstMac.toUpperCase()
          }
        });
      }
    } catch (err) {
      log.error("Failed to parse output: " + line, err);
    }
  }
}

module.exports = ICMP6Sensor;
