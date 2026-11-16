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
const { spawn } = require('child_process');
const readline = require('readline');
const sysManager = require('../net2/SysManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();
const Message = require('../net2/Message.js');
const sem = require('./SensorEventManager.js').getInstance();

class DeviceSTPSensor extends Sensor {
  constructor(config) {
    super(config);
    this.bridgeUuidMap = {};
  }

  async run() {
    const interval = this.config.interval * 1000 || 300 * 1000;
    sem.once('IPTABLES_READY', () => {
      // existing polling model, unchanged. It covers cold start and acts as a periodic safety net.
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

      // supplement the poll with an event-driven bridge fdb monitor for low-latency stp port updates
      this.updateBridgeUuidMap();
      this.spawnBridgeMonitor();
    });

    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      this.updateBridgeUuidMap();
    });
  }

  updateBridgeUuidMap() {
    const map = {};
    for (const intf of sysManager.getMonitoringInterfaces()) {
      if (intf.name && intf.name.startsWith('br'))
        map[intf.name] = intf.uuid;
    }
    this.bridgeUuidMap = map;
  }

  spawnBridgeMonitor() {
    if (this.bridgeMonitorProc) // guard against double-spawn
      return;
    const proc = spawn('bridge', ['monitor', 'fdb']);
    this.bridgeMonitorProc = proc;
    const reader = readline.createInterface({ input: proc.stdout });
    reader.on('line', (line) => {
      this.processFdbLine(line).catch((err) => {
        log.error(`Failed to process bridge fdb line: ${line}`, err.message);
      });
    });
    const restart = (reason) => {
      if (this.bridgeMonitorProc !== proc) // already handled / replaced
        return;
      this.bridgeMonitorProc = null;
      log.warn(`bridge monitor fdb terminated (${reason}), will be restarted soon`);
      setTimeout(() => {
        this.spawnBridgeMonitor();
      }, 3000);
    };
    proc.on('exit', (code, signal) => restart(`exit code=${code} signal=${signal}`));
    proc.on('error', (err) => restart(`error ${err.message}`));
  }

  // process a single "bridge monitor fdb" event line, e.g.
  //   00:e0:4c:68:0f:57 dev eth2 master br0            // new learning
  //   Deleted 00:e0:4c:68:0f:57 dev eth3 master br0    // deletion (ignored)
  async processFdbLine(line) {
    if (!line)
      return;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length === 0)
      return;
    if (tokens[0] === 'Deleted') // only process new learning, ignore deletion
      return;
    if (tokens.includes('permanent')) // parity with "grep -v permanent" in the poll
      return;
    const mac = tokens[0];
    const devIdx = tokens.indexOf('dev');
    const masterIdx = tokens.indexOf('master');
    if (devIdx < 0 || masterIdx < 0 || devIdx + 1 >= tokens.length || masterIdx + 1 >= tokens.length)
      return; // malformed / not a bridge fdb entry
    const dev = tokens[devIdx + 1];
    const bridge = tokens[masterIdx + 1];
    if (!mac || !dev || !bridge)
      return;
    if (!(bridge in this.bridgeUuidMap)) // ignore events from non-monitored bridges
      return;
    const host = hostManager.getHostFastByMAC(mac.toUpperCase()); // in-memory only, no redis read
    if (!host) // host not loaded yet, the poll will populate it
      return;
    const intf = host.getNicUUID();
    if (intf && intf !== this.bridgeUuidMap[bridge]) // do not record stp port if mac does not belong to this bridge network
      return;
    const stpPort = dev.split('.')[0]; // strip vlan id suffix
    if (host.o.stpPort !== stpPort) {
      log.info(`Update mac stp port via fdb monitor: ${mac} --> ${stpPort}`);
      await host.update({ stpPort }, true, true);
    }
  }

  async scanMacSTPPort() {
    const intfs = sysManager.getMonitoringInterfaces();
    const notBridgeIntfs = [];
    const macNicMap = {};
    for (const intf of intfs) {
      if (intf.name.startsWith('br')) {
        const result = await this.discoverMacViaSTP(intf.name, intf.uuid).catch((err) => {
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

  async discoverMacViaSTP(bridge, uuid) {
    const macNicMap = {};
    let results = await exec(`bridge fdb show br ${bridge} | grep -v permanent`).then(result => result.stdout.trim().split('\n').filter(line => line.length !== 0)).catch((err) => {});
    for (const result of results || []) {
      const [mac, _, dev] = result.split(' ', 3);
      if (!mac || !dev)
        continue;
      const {intf} = await hostTool.getKeysInMAC(mac.toUpperCase(), ["intf"]);
      if (intf && intf !== uuid) // do not record stp port if mac address does not belong to this bridge network
        continue;
      macNicMap[mac.toUpperCase()] = dev.split('.')[0]; // strip vlan id suffix
    }
    return macNicMap;
  }
      
  async discoverMacViaARP(eths) {
    const results = await exec(`cat /proc/net/arp | awk '$3 != "0x0" && $4 != "00:00:00:00:00:00" {print $4" "$6}' | tail -n +2`).then(result => result.stdout.trim().split('\n'));
    const macNicMap = {};
    for (const result of results || []) {
      const [mac, intf] = result.split(' ', 2);
      if (eths.includes(intf))
        macNicMap[mac.toUpperCase()] = intf.split('.')[0]; // strip vlan id suffix
    }
    return macNicMap;
  }
}

module.exports = DeviceSTPSensor;


