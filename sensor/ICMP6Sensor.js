/*    Copyright 2019-2022 Firewalla Inc.
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
const sysManager = require('../net2/SysManager.js');
const cp = require('child_process');
const execAsync = util.promisify(cp.exec);
const spawn = cp.spawn;
const Message = require('../net2/Message.js');

class ICMP6Sensor extends Sensor {
  constructor(config) {
    super(config);
    this.intfPidMap = {};
  }

  async restart() {
    for (const intf in this.intfPidMap) {
      const pid = this.intfPidMap[intf];
      const childPid = await execAsync(`ps -ef| awk '$3 == '${pid}' { print $2 }'`).then(result => result.stdout.trim()).catch(() => null);
      if (childPid)
        await execAsync(`sudo kill -9 ${childPid}`).catch((err) => { });
    }
    this.intfPidMap = {};
    const interfaces = sysManager.getMonitoringInterfaces();

    for (const intf of interfaces) {
      if (!intf.name || !intf.mac_address) continue;
      if (intf.name.endsWith(":0")) continue; // do not listen on interface alias since it is not a real interface
      if (intf.name.includes("vpn")) continue; // do not listen on vpn interface
      if (intf.name.startsWith("wg")) continue; // do not listen on wireguard interface
      // listen on icmp6 neighbor-advertisement which is not sent from firewalla
      const tcpdumpSpawn = spawn('sudo', ['tcpdump', '-i', intf.name, '-enl', `!(ether src ${intf.mac_address}) && icmp6 && ip6[40] == 136 && !vlan`]);
      const pid = tcpdumpSpawn.pid;
      log.info("TCPDump icmp6 started with PID: ", pid);
      this.intfPidMap[intf.name] = pid;
      const reader = readline.createInterface({
        input: tcpdumpSpawn.stdout
      });
      reader.on('line', (line) => {
        this.processNeighborAdvertisement(line, intf);
      });
      tcpdumpSpawn.on('close', (code) => {
        if (code) log.warn("TCPDump icmp6 exited with code: ", code, '\n  cmd:', tcpdumpSpawn.spawnargs.join(' '));
      });
    }
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(() => {
      this.restart().catch((err) => {
        log.error("Failed to start tcpdump for ICMP6", err);
      });
    }, 5000);
  }

  run() {
    this.scheduleReload();
    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      log.info("Schedule reload ICMP6Sensor since network info is reloaded");
      this.scheduleReload();
    })
  }

  processNeighborAdvertisement(line, intf) {
    // Each line of neighbor advertisement is like:
    // 03:06:30.894621 00:0c:29:96:3c:30 > 02:01:f4:16:26:dc, ethertype IPv6 (0x86dd), length 78: 2601:646:8800:eb7:dc04:b1fa:d0c2:6cbb > fe80::1:f4ff:fe16:26dc: ICMP6, neighbor advertisement, tgt is 2601:646:8800:eb7:dc04:b1fa:d0c2:6cbb, length 24
    try {
      const tokens = line.split(" ");
      if (!tokens[1])
        return;
      const dstMac = tokens[1];
      let pos = tokens.indexOf("ICMP6,");
      if (pos < 0)
        return;
      let dstIp = tokens[pos - 1];
      if (!dstIp)
        return;
      dstIp = dstIp.substring(0, dstIp.length - 1);
      if (sysManager.isMulticastIP6(dstIp))
        // do not process ICMP6 packet sent to multicast IP, the source mac not be the real mac
        return;
      pos = tokens.indexOf("is");
      if (pos < 0)
        return;
      let tgtIp = tokens[pos + 1];
      if (!tgtIp)
        return;
      // strip trailing comma
      tgtIp = tgtIp.substring(0, tgtIp.length - 1);
      log.verbose("Neighbor advertisement detected: " + dstMac + ", " + tgtIp);
      if (dstMac && ip.isV6Format(tgtIp)) {
        sem.emitEvent({
          type: "DeviceUpdate",
          message: `A new ipv6 is found @ ICMP6Sensor ${tgtIp} ${dstMac}`,
          host: {
            ipv6Addr: [tgtIp],
            mac: dstMac.toUpperCase(),
            intf_mac: intf.mac_address,
            intf_uuid: intf.uuid
          }
        });
      }
    } catch (err) {
      log.error("Failed to parse output: " + line + '\n', err);
    }
  }
}

module.exports = ICMP6Sensor;
