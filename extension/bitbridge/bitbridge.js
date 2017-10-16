
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

let instance = null

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}


class BitBridge {
  static getInstance() {
    return instance
  }
  
  constructor(intf, routerIP, selfIP) {
    if(!instance) {
      this.intf = intf
      this.routerIP = routerIP
      this.selfIP = selfIP
      this.spawnProcess = null
      this.started = false
      this.subscribeOnProcessExit()
      instance = this
    }

    return instance
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
    log.info("Starting BitBridge...")
    
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
      binary = this.getBinary()
      args = [this.intf, this.routerIP, this.selfIP, '-m','-q','-n'];

      let cmd = binary+" "+args.join(" ")
      log.info("Lanching Bitbridge7 ", cmd);
      require('child_process').execSync("echo '"+cmd +" ' > /home/pi/firewalla/bin/bitbridge4.sh");
      require('child_process').execSync("sudo service bitbridge4 restart"); // legacy issue to use bitbridge4
    }

    this.started = true
  }

  stop() {
    log.info("Stopping BitBridge...")

    try {
      if(firewalla.isDocker() || firewalla.isTravis()) {
        require('child_process').execSync("sudo pkill bitbridge7")
      } else {
        require('child_process').execSync("sudo service bitbridge4 stop") // legacy issue to use bitbridge4
      }
    } catch(err) {
      // ignore error
    }

    this.started = false
    
    return delay(1000) // delay for 1 second before return to ensure bitbridge is stopped
  }

  getBinary() {
    if(firewalla.getPlatform() === "x86_64") {
      return firewalla.getFirewallaHome() + "/bin/real.x86_64/bitbridge7";
    }
    
    return firewalla.getFirewallaHome() + "/bin/bitbridge7";
  }

}

module.exports = BitBridge
