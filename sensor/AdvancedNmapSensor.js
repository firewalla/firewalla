/**
 * Created by Melvin Tu on 29/06/2017.
 */
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

let log = require('../net2/logger.js')(__filename);

let util = require('util');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let Sensor = require('./Sensor.js').Sensor;

let networkTool = require('../net2/NetworkTool')();

let scriptConfig = require('../extension/nmap/scriptsConfig.json');

let NmapSensor = require('../sensor/NmapSensor');

let cp = require('child_process');

let spt = require('../net2/SystemPolicyTool')();

let Alarm = require('../alarm/Alarm');
let AlarmManager2 = require('../alarm/AlarmManager2');
let am2 = new AlarmManager2();

let Firewalla = require('../net2/Firewalla');

let xml2jsonBinary = Firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + Firewalla.getPlatform();
  
class AdvancedNmapSensor extends Sensor {
  constructor() {
    super();
    
    this.networkInterface = networkTool.getLocalNetworkInterface();
    this.networkRange = this.networkInterface && this.networkInterface.subnet;
  }

  run() {
    let firstScanTime = (30 + Math.random() * 60) * 1000; // 30 - 90 seconds
    let interval = (8 + Math.random() * 4) * 3600 * 1000; // 8-12 hours
    setTimeout(() => {
      this.checkAndRunOnce();
      setInterval(() => this.checkAndRunOnce, interval);
    }, firstScanTime);
  }
  
  createVulnerabilityAlarm(host, script) {
    let ip = host.ipv4Addr;
    let vid = script.key;
    let alarm = new Alarm.VulnerabilityAlarm(new Date() / 1000, ip, vid, {
      "p.device.ip": ip,
      "p.vuln.key": vid,
      "p.vuln.title": script.title,
      "p.vuln.state": script.state,
      "p.vuln.discolure": script.disclosure,
      "p.vuln.scriptID": script.id
    });

    am2.enrichDeviceInfo(alarm)
      .then((alarm) => {
	      return am2.checkAndSaveAsync(alarm)
	      .then(() => {
      		log.info("Created a vulnerability alarm", alarm.aid, "on device", ip, {});
        })
    }).catch((err) => {
      log.error("Failed to create vulnerability alarm:", err, err.stack, {});
    })
  }
  
  isSensorEnable() {
    return spt.isPolicyEnabled("vulScan");
  }
  
  checkAndRunOnce() {
    this.isSensorEnable()
      .then((result) => {
      if(result)
        this.runOnce();
      }).catch((err) => {
      log.error("Failed to check if sensor is enabled");
    })
  }
  
  runOnce() {
    if(!scriptConfig)
      return;

    log.info("Scanning network to detect vulnerability...");
    
    Object.keys(scriptConfig).forEach((scriptName) => {
      log.info("Running script", scriptName, {});
      
      let ports = scriptConfig[scriptName].ports;
      if(ports) {
        this._scan([scriptName], ports)
          .then((hosts) => {
            log.info("Analyzing scan result...");
            if(hosts.length === 0) {
              log.info("No vulnerability is found");
              return;
            }
            hosts.forEach((h) => {
              if(h.scripts) {
                h.scripts.forEach((script) => {
                  if(script.state === "VULNERABLE") {
                    log.info("Found vulnerability", script.key, "on host", h.ipv4Addr, {});
                    this.createVulnerabilityAlarm(h, script);  
                  }
                })
              }
            })
          });
      }
    })
  }
  
  _scan(scripts, ports) {
    if(!this.networkRange)
      return reject(new Error("require network range"));
    
    let portString = ports.join(",");
    
    let scriptPaths = scripts.map((scriptName) => 
      util.format("--script %s/extension/nmap/scripts/%s", Firewalla.getFirewallaHome(), scriptName));
    
    // nmap -Pn -p445 -n --script ~/Downloads/smb-vuln-ms17-010.nse 10.0.1.0/24 -oX - | ./xml2json
    let cmd = util.format("sudo nmap -n -Pn -p%s --host-timeout 60s %s %s -oX - | %s", 
      portString, scriptPaths.join(" "), this.networkRange, xml2jsonBinary);
    
    return new Promise((resolve, reject) => {
      cp.exec(cmd, (err, stdout, stderr) => {
        
        if(err || stderr) {
          reject(err || new Error(stderr));
          return;
        }

        let findings = null;
        try {
          findings = JSON.parse(stdout);
        } catch (err) {
          reject(err);
        }
        
        if(!findings) {
          return;
        }

        let hostsJSON = findings.nmaprun && findings.nmaprun.host;
        
        if(hostsJSON.constructor !== Array) {
          hostsJSON = [hostsJSON];
        }
        
        let hosts = hostsJSON.map(NmapSensor.parseNmapHostResult)
          .filter((x) => x.scripts && x.scripts.length > 0);
        
        resolve(hosts);
      })
    });
    
  }
  
}

module.exports = AdvancedNmapSensor;

