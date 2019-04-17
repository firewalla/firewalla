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

const exec = require('child-process-promise').exec

const fc = require('../../net2/config.js')

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
    intf = intf || "eth0";
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
      log.info("starting new spoofing: ", binary, args, {});

      this.spawnProcess.stdout.pipe(logStream);
      this.spawnProcess.stderr.pipe(logStream);

      this.spawnProcess.on('exit', (code) => {
        log.info("spoofing binary exited with code " + code);
      });

    } else {
      if (!this.isV6) {
        binary = this.getBinary()
        args = [this.intf, this.routerIP, this.selfIP, '-m','-n','-q','-l','-d 0'];
  
        let cmd = binary+" "+args.join(" ")
        log.info("Launching Bitbridge4 ", cmd);
        // crate corresponding rc file
        const rcFilePath = `${firewalla.getFirewallaHome()}/bin/bitbridge7.${this.intf}_${this.routerIP}.rc`
        fs.writeFileSync(rcFilePath, `export BINARY_ARGUMENTS='${args.join(" ")}'`);
        // Beware that restart bitbridge4 service will restart all b7 instances
        require('child_process').execSync("sudo service bitbridge4 restart"); // legacy issue to use bitbridge4
      } else {
        binary = this.getBinary6()
        args = [this.intf, '-w 0.18','-q','-k monitored_hosts6','-g '+this.routerIP];
        
        let cmd = binary+" "+args.join(" ")
        log.info("Launching Bitbridge6", cmd);
        const rcFilePath = `${firewalla.getFirewallaHome()}/bin/bitbridge6.${this.intf}_${this.routerIP}.rc`;
        fs.writeFileSync(rcFilePath, `export BINARY_ARGUMENTS='${args.join(" ")}'`);
        // Beware that restart bitbridge6 service will restart all b6 instances
        require('child_process').execSync("sudo service bitbridge6 restart"); // legacy issue to use bitbridge4
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
          require('child_process').execSync("sudo service bitbridge4 restart")
        } else {
          // remove corresponding rc file
          const rcFilePath = `${firewalla.getFirewallaHome()}/bin/bitbridge6.${this.intf}_${this.routerIP}.rc`;
          if (fs.existsSync(rcFilePath)) {
            fs.unlinkSync(rcFilePath);
          }
          // restart bitbirdge6 service
          require('child_process').execSync("sudo service bitbridge6 restart")
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
