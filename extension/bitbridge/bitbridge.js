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
'use strict'

let firewalla = require('../../net2/Firewalla.js')
let log = require("../../net2/logger.js")(__filename)

let fs = require('fs')

let spawn = require('child_process').spawn
let Promise = require('bluebird');

const platform = require('../../platform/PlatformLoader.js').getPlatform();
const Config = require('../../net2/config.js');

const exec = require('child-process-promise').exec
let b4RestartTask = null;
let b6RestartTask = null;

let instances = {};

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}


class BitBridge {
  static createInstance(intf, routerIP, selfIP, isV6) {
    // factory method to get singleton instance of bitbridge
    isV6 = isV6 || false;
    if (!routerIP) {
      log.error("Cannot create bitbridge instance. Router IP should be specified.");
      return null;
    }
    if (!selfIP && !isV6) {
      log.error("Cannot create bitbridge instance. Self IP should be specified for ipv4.");
      return null;
    }
    const config = Config.getConfig(true);
    intf = intf || config.monitoringInterface;
    let key = `${intf}_v4_${routerIP}_${selfIP}`;
    if (isV6) {
      key = `${intf}_v6_${routerIP}`;
    }
    if (!instances[key]) {
      const instance = new BitBridge(intf, routerIP, selfIP, isV6);
      instances[key] = instance;
    }
    return instances[key];
  }

  // this function should only be invoked in bitbridge.start/stop. Please follow this rule
  // bitbridge services should not be explicitly started elsewhere
  static scheduleRestartB4() {
    if (!b4RestartTask) {
      b4RestartTask = setTimeout(() => {
        // multiple processes belong to bitbridge4 service. Stop can ensure all processes are stopped before start
        exec(`sudo systemctl stop bitbridge4; sudo systemctl start bitbridge4`).catch((err) => {
          log.error("Failed to restart bitbridge4", err.message);
        });
      }, 5000);
    } else {
      b4RestartTask.refresh();
    }
  }

  // this function should only be invoked in bitbridge.start/stop. Please follow this rule
  // bitbridge services should not be explicitly started elsewhere
  static scheduleRestartB6() {
    if (!b6RestartTask) {
      b6RestartTask = setTimeout(() => {
        // multiple processes belong to bitbridge6 service. Stop can ensure all processes are stopped before start
        exec(`sudo systemctl stop bitbridge6; sudo systemctl start bitbridge6`).catch((err) => {
          log.error("Failed to restart bitbridge6", err.message);
        });
      }, 5000);
    } else {
      b6RestartTask.refresh();
    }
  }

  static async cleanupSpoofInstanceConfigs() {
    // cleanup rc files in directory
    try {
      const cmd = `ls ${firewalla.getFirewallaHome()}/bin/bitbridge7.*.rc && rm ${firewalla.getFirewallaHome()}/bin/bitbridge7.*.rc; true`;
      await exec(cmd);
    } catch (err) { // file does not exist?
      log.error("Failed to remove bitbridge7.*.rc", err);
    }
    try {
      const cmd = `ls ${firewalla.getFirewallaHome()}/bin/bitbridge6.*.rc && rm ${firewalla.getFirewallaHome()}/bin/bitbridge6.*.rc; true`;
      await exec(cmd);
    } catch (err) { // file does not exist?
      log.error("Failed to remove bitbridge6.*.rc", err);
    }
  }
  
  constructor(intf, routerIP, selfIP, isV6) {
    this.intf = intf
    this.routerIP = routerIP
    this.selfIP = selfIP
    this.spawnProcess = null
    this.started = false
    this.subscribeOnProcessExit()
    this.isV6 = isV6
  }

  subscribeOnProcessExit() {
    process.on('exit', () => {
      if(this.started) {
        log.info("Terminating bitbridge on exit")
        this.stop()
      }
    });    
  }

  start() {
    log.info(`Starting BitBridge, interface: ${this.intf}, router: ${this.routerIP}, self: ${this.selfIP}, IPv6: ${this.isV6}`);
    
    let binary = null, args = null;

    if(firewalla.isDocker() || firewalla.isTravis()) {

      // always stop before start
      this.stop()
      
      binary = "sudo";
      args = [this.getBinary(), this.intf, this.routerIP, this.selfIP,'-m','-q','-n'];

      let logStream = fs.createWriteStream("/dev/null", {flags: 'a'});

      this.spawnProcess = spawn(binary, args);
      log.info("starting new spoofing: ", binary, args);

      this.spawnProcess.stdout.pipe(logStream);
      this.spawnProcess.stderr.pipe(logStream);

      this.spawnProcess.on('exit', (code) => {
        log.info("spoofing binary exited with code " + code);
      });

    } else {
      if (!this.isV6) {
        binary = this.getBinary()
        args = [this.intf, this.routerIP, this.selfIP, '-m','-n','-q','-l','-d 0', `-k monitored_hosts_${this.intf}`];
  
        let cmd = binary+" "+args.join(" ")
        log.info("Launching Bitbridge4 ", cmd);
        // crate corresponding rc file
        const rcFilePath = `${firewalla.getFirewallaHome()}/bin/bitbridge7.${this.intf}_${this.routerIP}.rc`
        fs.writeFileSync(rcFilePath, `export BINARY_ARGUMENTS='${args.join(" ")}'`);
        // Beware that restart bitbridge4 service will restart all b7 instances
        BitBridge.scheduleRestartB4(); // legacy issue to use bitbridge4
      } else {
        binary = this.getBinary6()
        args = [this.intf, '-w 0.18','-q','-g '+this.routerIP, `-k monitored_hosts6_${this.intf}`];
        
        let cmd = binary+" "+args.join(" ")
        log.info("Launching Bitbridge6", cmd);
        const rcFilePath = `${firewalla.getFirewallaHome()}/bin/bitbridge6.${this.intf}_${this.routerIP}.rc`;
        fs.writeFileSync(rcFilePath, `export BINARY_ARGUMENTS='${args.join(" ")}'`);
        // Beware that restart bitbridge6 service will restart all b6 instances
        BitBridge.scheduleRestartB6(); // legacy issue to use bitbridge4
      }              
    }

    this.started = true
  }

  stop() {
    log.info(`Stoping BitBridge, interface: ${this.intf}, router: ${this.routerIP}, self: ${this.selfIP}, IPv6: ${this.isV6}`);

    try {
      if(firewalla.isDocker() || firewalla.isTravis()) {
        require('child_process').execSync("sudo pkill bitbridge7")
        require('child_process').execSync("sudo pkill bitbridge6")
      } else {
        if (!this.isV6) {
          // remove corresponding rc file
          const rcFilePath = `${firewalla.getFirewallaHome()}/bin/bitbridge7.${this.intf}_${this.routerIP}.rc`;
          if (fs.existsSync(rcFilePath)) {
            fs.unlinkSync(rcFilePath);
          }
          // restart bitbridge4 service
          BitBridge.scheduleRestartB4();
        } else {
          // remove corresponding rc file
          const rcFilePath = `${firewalla.getFirewallaHome()}/bin/bitbridge6.${this.intf}_${this.routerIP}.rc`;
          if (fs.existsSync(rcFilePath)) {
            fs.unlinkSync(rcFilePath);
          }
          // restart bitbirdge6 service
          BitBridge.scheduleRestartB6();
        }
      }
    } catch(err) {
      // ignore error
    }

    this.started = false    
    
    return delay(1000) // delay for 1 second before return to ensure bitbridge is stopped
  }

  getBinary() {
    return platform.getB4Binary();
  }

  getBinary6() {
    return platform.getB6Binary();
  }
}

module.exports = BitBridge
