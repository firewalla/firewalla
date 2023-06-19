/*    Copyright 2020-2021 Firewalla Inc.
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
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const firewalla = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');
const fs = require('fs');
const util = require('util');
const writeFileAsync = util.promisify(fs.writeFile);
const existsAsync = util.promisify(fs.exists);
const bone = require("../lib/Bone.js");
const rclient = require('../util/redis_manager.js').getRedisClient();
const cp = require('child_process');
const execAsync = util.promisify(cp.exec);
const scanDictPath = `${firewalla.getHiddenFolder()}/run/scan_dict`;
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const xml2jsonBinary = firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + firewalla.getPlatform();
const _ = require('lodash');
const bruteConfig = require('../extension/nmap/bruteConfig.json');
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const featureName = "internal_scan";

const extensionManager = require('./ExtensionManager.js')

class InternalScanSensor extends Sensor {
  async apiRun() {

    this.running = false;
    this.supportPorts = ["tcp_23", "tcp_80", "tcp_21", "tcp_3306", "tcp_6379"]; // default support: telnet http ftp mysql redis

    if (platform.supportSSHInNmap()) {
      this.supportPorts.push("tcp_22");
    }

    extensionManager.onGet("getScanStatus", async (msg, data) => {
      return this.scanStatus;
    });

    extensionManager.onCmd("killScanSession", async (msg, data) => {
      this.killCmd = true;
      // this.currentPid is the bash command process
      if (this.currentPid) {
        // cPid is sudo process which fork from currentPid
        const cPid = await execAsync(`ps -ef| grep nmap| awk '$3 == '${this.currentPid}' { print $2 }'`).then(result => result.stdout.trim()).catch(() => null);
        // ccPid is timeout process which fork from cPid
        const ccPid = await execAsync(`ps -ef| grep nmap| awk '$3 == '${cPid}' { print $2 }'`).then(result => result.stdout.trim()).catch(() => null);
        // cccPid is nmap process which fork from ccPid
        const cccPid = await execAsync(`ps -ef| grep nmap| awk '$3 == '${ccPid}' { print $2 }'`).then(result => result.stdout.trim()).catch(() => null);
        if (cccPid) await execAsync(`sudo kill -9 ${cccPid}`).catch((err) => { });
      }
    });

    extensionManager.onCmd("startScanSession", async (msg, data) => {
      if (!this.running) {
        this.killCmd = false;
        await this.runOnce();
        return {"msg":"start scan"} 
      } else {
        return {"msg":"previous scan is running"} 
      }
    });

  }

  // async run() {
  //   fc.onFeature(featureName, (feature, status) => {
  //     if (feature != featureName)
  //       return
  //     if (status) {
  //       this.checkAndRunOnce();
  //     }
  //   })
  // }

  async checkAndRunOnce() {
    await this.runOnce();

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    const interval = this.config.interval * 1000 || 7 * 24 * 60 * 60 * 1000; // one week
    this.timeoutId = setTimeout(async () => {
      await this.checkAndRunOnce();
    }, interval);
  }

  async runOnce() {
    const result = await this.isSensorEnable();
    if (!result || this.running) {
      return;
    }

    this.running = true;
    this.scanStatus = {};
    try {
      log.info('Scan start...');
      await this.checkDictionary();

      let results = await hostManager.getHostsAsync();
      results = results && results.filter((host) => host && host.o && host.o.mac && host.o.ipv4Addr && host.o.openports);
      for (const host of results) {
        if (this.killCmd) throw new Error("scan interruptted")
        let openPorts = host.o.openports
        log.info(host.o.ipv4Addr, openPorts);
        let mergePorts = [];
        if (openPorts.tcp && openPorts.tcp.length > 0) {
          mergePorts = mergePorts.concat(openPorts.tcp.map((port) => "tcp_" + port));
        }
        if (openPorts.udp && openPorts.udp.length > 0) {
          mergePorts = mergePorts.concat(openPorts.udp.map((port) => "udp_" + port));
        }
        const hostName = host.name();
        const waitPorts = this.supportPorts.filter((portid) => mergePorts.includes(portid));
        log.info("Scanning device: ", host.o.ipv4Addr, waitPorts);
        this.scanStatus[host.o.ipv4Addr] = {}
        for (const portid of waitPorts) {
          const nmapBrute = bruteConfig[portid];
          if (nmapBrute) {
            this.scanStatus[host.o.ipv4Addr][portid] = "scanning"
            await this.nmapGuessPassword(host.o.ipv4Addr, hostName, nmapBrute);
            this.scanStatus[host.o.ipv4Addr][portid] = "scanned"
          }
        }
      };
    } catch (err) {
     log.error("Failed to scan: " + err);
    }
    this.running = false;
    this.currentPid = undefined;
    log.info('Scan end');
  }

  isSensorEnable() {
    return fc.isFeatureOn(featureName);
  }

  async checkDictionary() {
    let mkdirp = util.promisify(require('mkdirp'));
    const dictShaKey = "scan:dictionary.sha256";
    const redisShaData = await rclient.getAsync(dictShaKey);
    let boneShaData = await bone.hashsetAsync(dictShaKey);
    //let boneShaData = Date.now() / 1000;
    if (boneShaData && boneShaData != redisShaData) {
      await rclient.setAsync(dictShaKey, boneShaData);

      log.info(`Loading dictionary from cloud...`);
      const data = await bone.hashsetAsync("scan:dictionary");
      //const data = require('./scan_dict.json');
      if (data) {
        try {
          await mkdirp(scanDictPath);
        } catch (err) {
          log.error("Error when mkdir:", err);
          return;
        }

        const dictData = JSON.parse(data);
        //const dictData = data;
        const commonUser = dictData.common && dictData.common.map(current => current.user);
        const commonPwds = dictData.common && dictData.common.map(current => current.password);
        const keys = Object.keys(dictData);
        for (const key of keys) {
          if (key == "common") {
            continue;
          }

          let scanUsers = dictData[key].map(current => current.user);
          scanUsers.push.apply(scanUsers, commonUser);
          const txtUsers = _.uniqWith(scanUsers, _.isEqual).join("\n");
          if (scanUsers.length > 0) {
            await writeFileAsync(scanDictPath + "/" + key.toLowerCase() + "_users.lst", txtUsers);
          }
          let scanPwds = dictData[key].map(current => current.password);
          scanPwds.push.apply(scanPwds, commonPwds);
          const txtPwds = _.uniqWith(scanPwds, _.isEqual).join("\n");
          if (scanPwds.length > 0) {
            await writeFileAsync(scanDictPath + "/" + key.toLowerCase() + "_pwds.lst", txtPwds);
          }
        }
      }
    }
  }

  _getCmdStdout(cmd) {
    return new Promise((resolve, reject) => {
      const r = cp.exec(cmd, (error, stdout, stderr) => {
        if (error) {
          reject(error)
        } else if (stderr.length > 0) {
          reject(stderr)
        } else {
          resolve(stdout)
        }
      })
      this.currentPid = r.pid;
    })
  }

  async nmapGuessPassword(ipAddr, hostName, nmapBrute) {
    const { port, serviceName, protocol, scripts } = nmapBrute;
    let weakPasswords = [];
    for (const bruteScript of scripts) {
      let scriptArgs = [];
      if (bruteScript.scriptArgs) {
        scriptArgs.push(bruteScript.scriptArgs);
      }
      if (bruteScript.scriptName.indexOf("brute") > -1) {
        const scanUsersFile = scanDictPath + "/" + serviceName.toLowerCase() + "_users.lst"
        if (await existsAsync(scanUsersFile)) {
          scriptArgs.push("userdb=" + scanUsersFile);
        }
        const scanPwdsFile = scanDictPath + "/" + serviceName.toLowerCase() + "_pwds.lst"
        if (await existsAsync(scanPwdsFile)) {
          scriptArgs.push("passdb=" + scanPwdsFile);
        }
      }
      // nmap -p 22 --script telnet-brute --script-args telnet-brute.timeout=8s,userdb=./userpass/myusers.lst,passdb=./userpass/mypwds.lst 192.168.1.103
      let cmdArg = [];
      cmdArg.push(util.format('--script %s', bruteScript.scriptName));
      if (bruteScript.otherArgs) {
        cmdArg.push(bruteScript.otherArgs);
      }
      if (scriptArgs.length > 0) {
        cmdArg.push(util.format('--script-args %s', scriptArgs.join(',')));
      }
      const cmd = util.format('sudo timeout 1200s nmap -p %s %s %s -oX - | %s', port, cmdArg.join(' '), ipAddr, xml2jsonBinary);
      log.info("Running command:", cmd);
      const startTime = Date.now() / 1000;
      try {
        let result;
        try {
          result = await this._getCmdStdout(cmd);
        } catch (err) {
          log.error("command execute fail", err);
          return;
        }
        let output = JSON.parse(result);
        let findings = null;
        if (bruteScript.scriptName == "redis-info") {
          findings = _.get(output, `nmaprun.host.ports.port.service.version`, null);
          if (findings != null) {
            weakPasswords.push({username: "", password: ""});  //empty password access
          }
        } else {
          findings = _.get(output, `nmaprun.host.ports.port.script.table.table`, null);
          if (findings != null) {
            if (findings.constructor === Object)  {
              findings = [findings]
            }

            for (const finding of findings) {
              let weakPassword = {};
              finding.elem.forEach((x) => {
                switch (x.key) {
                  case "username":
                    weakPassword.username = x["#content"];
                    break;
                  case "password":
                    weakPassword.password = x["#content"];
                    break;
                  default:
                }
              });
              weakPasswords.push(weakPassword);
            }
          }
        }        
      } catch (err) {
        log.error("Failed to nmap scan:", err);
      }
      log.info("used Time: ", Date.now() / 1000 - startTime);

      const result = await this.isSensorEnable();
      if (!result) {
        return;
      }
    }

    if (weakPasswords.length > 0) {
      let alarm = new Alarm.WeakPasswordAlarm(
        Date.now() / 1000,
        hostName,
        {
          'p.source': 'InternalScanSensor',
          'p.device.ip': ipAddr,
          'p.open.port': port,
          'p.open.protocol': protocol,
          'p.open.servicename': serviceName,
          'p.weakpasswords': weakPasswords
        }
      );
      await am2.enqueueAlarm(alarm);
    } else {
      log.info("not find user/password");
    }
  }
}

module.exports = InternalScanSensor;
