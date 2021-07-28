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

const Sensor = require('./Sensor.js').Sensor;

const exec = require('child-process-promise').exec;
const sysManager = require('../net2/SysManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const sem = require('./SensorEventManager.js').getInstance();

class DeviceSTPSensor extends Sensor {
  async run() {
    const interval = this.config.interval * 1000 || 300 * 1000;
    sem.once('IPTABLES_READY', () => {
      setTimeout(() => {
        this.scanMacSTPPort().catch((err) => {
          log.error("Failed to scan MAC STP port", err.message);
        });
        setInterval(() => {
          this.scanMacSTPPort().catch((err) => {
            log.error("Failed to scan MAC STP port", err.message);
          });
        }, interval);
      }, 60000);
    });
    
  }

  async scanMacSTPPort() {
    const intfs = sysManager.getMonitoringInterfaces();
    const notBridgeIntfs = [];
    const macNicMap = {};
    for (const intf of intfs) {
      if (intf.name.startsWith('br')) {
        const result = await this.discoverMacViaSTP(intf.name).catch((err) => {
          log.error(`Failed to discover MAC via STP on ${intf.name}`, err.message);
          return {};
        });
        Object.assign(macNicMap, result);
      } else {
        notBridgeIntfs.push(intf.name);
      }
    }
    const result = await this.discoverMacViaARP(notBridgeIntfs).catch((err) => {
      log.error(`Failed to discover MAC via ARP on ${notBridgeIntfs.join(',')}`, err.message);
      return {};
    });
    Object.assign(macNicMap, result);
    for (const mac of Object.keys(macNicMap)) {
      const macEntry = await hostTool.getMACEntry(mac);
      if (macEntry) {
        log.debug(`Update mac stp port: ${mac} --> ${macNicMap[mac]}`);
        await hostTool.updateKeysInMAC(mac, {stpPort: macNicMap[mac]});
      }
    }
  }

  async discoverMacViaSTP(bridge) {
    let results = await exec(`brctl showstp ${bridge} | grep -v "^ " | grep -v "${bridge}"`).then(result => result.stdout.trim().split('\n').filter(line => line.length !== 0));
    const numberNicMap = {};
    for (const result of results) {
      const [intf, number] = result.split(' ', 2);
      numberNicMap[number.substring(1, number.length - 1)] = intf.split('.')[0]; // strip vlan id suffix
    }
    results = await exec(`brctl showmacs ${bridge} | tail -n +2 | awk '{print $1" "$2}'`).then(result => result.stdout.trim().split('\n'));
    const macNicMap = {};
    for (const result of results) {
      const [number, mac] = result.split(' ', 2);
      if (numberNicMap[number])
        macNicMap[mac.toUpperCase()] = numberNicMap[number];
    }
    return macNicMap;
  }
      
  async discoverMacViaARP(eths) {
    const results = await exec(`cat /proc/net/arp | awk '$3 != "0x0" && $4 != "00:00:00:00:00:00" {print $4" "$6}' | tail -n +2`).then(result => result.stdout.trim().split('\n'));
    const macNicMap = {};
    for (const result of results) {
      const [mac, intf] = result.split(' ', 2);
      if (eths.includes(intf))
        macNicMap[mac.toUpperCase()] = intf.split('.')[0]; // strip vlan id suffix
    }
    return macNicMap;
  }
}

module.exports = DeviceSTPSensor;


