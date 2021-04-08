/**
 * Created by Melvin Tu on 29/06/2017.
 */
/*    Copyright 2017-2021 Firewalla Inc.
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

const Sensor = require('./Sensor.js').Sensor;

const networkTool = require('../net2/NetworkTool')();

const scriptConfig = require('../extension/nmap/scriptsConfig.json');

const NmapSensor = require('../sensor/NmapSensor');

const spt = require('../net2/SystemPolicyTool')();

const Alarm = require('../alarm/Alarm');
const AlarmManager2 = require('../alarm/AlarmManager2');
const am2 = new AlarmManager2();

const sysManager = require('../net2/SysManager.js')

const Firewalla = require('../net2/Firewalla');

const xml2jsonBinary =
  Firewalla.getFirewallaHome() +
  '/extension/xml2json/xml2json.' +
  Firewalla.getPlatform();

class AdvancedNmapSensor extends Sensor {
  constructor(config) {
    super(config);
  }

  getNetworkRanges() {
    const results = sysManager.getMonitoringInterfaces()
    const networkRanges =
      results &&
      results.map(x => networkTool.capSubnet(x.subnet));
    return networkRanges;
  }

  run() {
    const firstScanTime = (30 + Math.random() * 60) * 1000; // 30 - 90 seconds
    const interval = (8 + Math.random() * 4) * 3600 * 1000; // 8-12 hours
    setTimeout(() => {
      this.checkAndRunOnce();
      setInterval(() => this.checkAndRunOnce, interval);
    }, firstScanTime);
  }

  createVulnerabilityAlarm(host, script) {
    try {
      const ip = host.ipv4Addr;
      const vid = script.key;
      const alarm = new Alarm.VulnerabilityAlarm(new Date() / 1000, ip, vid, {
        'p.device.ip': ip,
        'p.vuln.key': vid,
        'p.vuln.title': script.title,
        'p.vuln.state': script.state,
        'p.vuln.discolure': script.disclosure,
        'p.vuln.scriptID': script.id
      });

      am2.enqueueAlarm(alarm);
      log.info('Created a vulnerability alarm', alarm.aid, 'on device', ip);
    } catch(err) {
      log.error('Failed to create vulnerability alarm:', err, err.stack);
    }
  }

  isSensorEnable() {
    return spt.isPolicyEnabled('vulScan');
  }

  async checkAndRunOnce() {
    try {
      const result = await this.isSensorEnable()
      if (result) {
        const ranges = this.getNetworkRanges()
        await this.runOnce(ranges);
      }
    } catch(err) {
      log.error('Failed to run vulnerability scan', err);
    }
  }

  async runOnce(networkRanges) {
    if (!scriptConfig) return;

    log.info('Scanning network to detect vulnerability...');

    for (const scriptName of Object.keys(scriptConfig)) {
      log.info('Running script', scriptName);

      const ports = scriptConfig[scriptName].ports;

      if (!ports) continue;

      if (!networkRanges)
        throw new Error('Network range is required');

      for (const range of networkRanges) {
        let hosts = await this._scan(range, [scriptName], ports)
        log.info('Analyzing scan result...');

        // ignore any hosts
        hosts = (hosts || []).filter(x => x.scripts && x.scripts.length > 0);

        if (hosts.length === 0) {
          log.info('No vulnerability is found');
          return;
        }
        hosts.forEach(h => {
          if (h.scripts) {
            h.scripts.forEach(script => {
              if (script.state === 'VULNERABLE') {
                log.info( 'Found vulnerability', script.key, 'on host', h.ipv4Addr);
                this.createVulnerabilityAlarm(h, script);
              }
            });
          }
        });
      }
    }
  }

  _scan(range, scripts, ports) {
    const portString = ports.join(',');

    const scriptPaths = scripts.map(scriptName =>
      util.format(
        '--script %s/extension/nmap/scripts/%s',
        Firewalla.getFirewallaHome(),
        scriptName
      )
    );

    // nmap -Pn -p445 -n --script ~/Downloads/smb-vuln-ms17-010.nse 10.0.1.0/24 -oX - | ./xml2json
    const cmd = util.format(
      'sudo timeout 1200s nmap -n -Pn -p%s --host-timeout 60s %s %s -oX - | %s',
      portString,
      scriptPaths.join(' '),
      range,
      xml2jsonBinary
    );

    return NmapSensor.scan(cmd);
  }
}

module.exports = AdvancedNmapSensor;
