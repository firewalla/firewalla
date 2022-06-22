/*    Copyright 2021 Firewalla Inc.
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

const sem = require('./SensorEventManager.js').getInstance();

const Sensor = require('./Sensor.js').Sensor;
const sysManager = require('../net2/SysManager.js');
const cp = require('child_process');
const execAsync = util.promisify(cp.exec);
const spawn = cp.spawn;
const Message = require('../net2/Message.js');
const { Address4 } = require('ip-address');

const PlatformLoader = require('../platform/PlatformLoader.js');
const platform = PlatformLoader.getPlatform();

const HostTool = require('../net2/HostTool.js');
const ht = new HostTool();

const LRU = require('lru-cache');

class ARPSensor extends Sensor {
  constructor(config) {
    super(config);
    this.intfPidMap = new Map();
    this.cache = new LRU({
      max: 600,
      maxAge: 1000 * 60 * 3
    });
  }

  async restart() {
    this.cache.reset();
    // kill existing child process
    for (const pid of this.intfPidMap.values()) {
      const childPid = await execAsync(`ps -ef| awk '$3 == '${pid}' { print $2 }'`).then(result => result.stdout.trim()).catch(() => null);
      if (childPid) {
        await execAsync(`sudo kill -9 ${childPid}`).catch((err) => { });
      }
    }
    this.intfPidMap.clear();

    const interfaces = sysManager.getMonitoringInterfaces();
    for (const intf of interfaces) {
      if (!intf.name || !intf.mac_address) continue;
      if (intf.name.endsWith(":0")) continue; // do not listen on interface alias since it is not a real interface
      if (intf.name.includes("vpn") || intf.name.includes("wg")) continue; // do not listen on vpn interface

      const tcpdumpSpawn = spawn('sudo', ['tcpdump', '-i', intf.name, '-enl', `!vlan && !(ether src ${intf.mac_address}) && arp and arp[6:2] == 2`]); // do not capture 802.1q frame on base interface, a seprate tcpdump process will listen on vlan interface
      const pid = tcpdumpSpawn.pid;

      /* tcpdump output sample
        09:54:06.270894 f8:e4:3b:4f:6a:7c > 20:6d:31:ee:f2:2e, ethertype ARP (0x0806), length 60: Ethernet (len 60, IPv4 (len 4), Reply 192.168.45.155 is-at f8:e4:3b:4f:6a:7c, length 46
      */

      log.info("TCPDump arp monitor started with PID: ", pid);
      this.intfPidMap.set(intf.name, pid);

      const reader = readline.createInterface({
        input: tcpdumpSpawn.stdout
      });
      reader.on('line', (line) => {
        void this.processArpMessage(line, intf);
      });
      tcpdumpSpawn.on('close', (code) => {
        log.info(`TCPDump arp monitor on ${intf.name} exited with code: `, code);
      });
    }
  }

  scheduleReload() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(() => {
      this.restart().catch((err) => {
        log.error("Failed to start ip monitor", err);
      });
    }, 5000);
  }

  run() {
    this.scheduleReload();
    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      log.info("Schedule reload ip monitor since network info is reloaded");
      this.scheduleReload();
    });
  }

  async processArpMessage(line, intf) {
    const tokens = line.split(" ");

    const pos = tokens.indexOf("is-at");

    if (pos < 1) {
      return;
    }
    const ipAddr = tokens[pos - 1];
    let mac = tokens[pos + 1].toUpperCase();
    // trim trailing comma
    mac = mac.substring(0, mac.length - 1);

    if (!ht.isMacAddress(mac)) {
      return;
    }
    if (!new Address4(ipAddr).isValid()) {
      return;
    }

    // Use both ip and mac as key to cache.
    const cacheValue = `${ipAddr},${mac}`;
    if (this.cache.get(ipAddr) === cacheValue && this.cache.get(mac) === cacheValue) {
      // Stop processing as it's in cache
      // log.info("Hit cache", ipAddr, mac);
      return;
    }
    this.cache.set(ipAddr, cacheValue);
    this.cache.set(mac, cacheValue);

    // Ignore multicast ip
    if (sysManager.isMulticastIP(ipAddr)) {
      return;
    }

    if (platform.isOverlayNetworkAvailable()) {
      if (ipAddr && ipAddr === sysManager.myIp2()) {
        return;
      }
      const ip4 = new Address4(ipAddr);
      const defIntf = sysManager.getDefaultWanInterface();
      const gatewayMac = await sysManager.myGatewayMac(defIntf.name);
      if (ip4.isInSubnet(defIntf.subnetAddress4) && mac === gatewayMac) {
        return;
      }
    }

    let host = {
      mac: mac,
      ipv4Addr: ipAddr,
      intf_mac: intf.mac_address,
      intf_uuid: intf.uuid,
      from: "arp"
    };

    sem.emitEvent({
      type: "DeviceUpdate",
      message: `A device is found @ ARPSensor ${ipAddr} ${mac}`,
      host: host
    });
  }
}

module.exports = ARPSensor;