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
  
  constructor(intf, routerIP, selfIP, selfMac, selfIP6, routerIP6) {
    if(!instance) {
      this.intf = intf
      this.routerIP = routerIP
      this.selfIP = selfIP
      this.spawnProcess = null
      this.started = false
      this.subscribeOnProcessExit()
      this.selfMac = selfMac
      this.selfIP6 = selfIP6
      this.routerIP6 = routerIP6 
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
      args = [this.intf, this.routerIP, this.selfIP, '-m','-n','-q','-l','-d 0'];

      let cmd = binary+" "+args.join(" ")
      log.info("Lanching Bitbridge4 ", cmd);
      fs.writeFileSync(`${firewalla.getFirewallaHome()}/bin/bitbridge7.rc`,
                       `export BINARY_ARGUMENTS='${args.join(" ")}'`)
      require('child_process').execSync("sudo service bitbridge4 restart"); // legacy issue to use bitbridge4

      //sudo ./bitbridge6 eth0 -q -w 1 -k monitored_hosts6 -g fe80::250:f1ff:fe80:0
      if(this.routerIP6) {
        binary = this.getBinary6()
        args = [this.intf, '-w 0.18','-q','-k monitored_hosts6','-g '+this.routerIP6];
        
        cmd = binary+" "+args.join(" ")
        log.info("Lanching bitbridge6", cmd);
        fs.writeFileSync(`${firewalla.getFirewallaHome()}/bin/bitbridge6.rc`,
                         `export BINARY_ARGUMENTS='${args.join(" ")}'`)
        
        require('child_process').execSync("sudo service bitbridge6 restart"); // legacy issue to use bitbridge4

        (async () => {
          if(fc.isFeatureOn("ipv6")) {
            await this.ipv6On();
          } else {
            await this.ipv6Off();
          }
          fc.onFeature("ipv6", (feature, status) => {
            if(feature != "ipv6")
              return
            
            if(status) {
              this.ipv6On()
            } else {
              this.ipv6Off()
            }
          })          
        })()

      } else {
        log.info("IPV6 not supported in current network environment, lacking ipv6 router")
      }                 
    }

    this.started = true
  }

  stop() {
    log.info("Stopping BitBridge...")

    try {
      if(firewalla.isDocker() || firewalla.isTravis()) {
        require('child_process').execSync("sudo pkill bitbridge7")
        require('child_process').execSync("sudo pkill bitbridge6")
      } else {
        require('child_process').execSync("sudo service bitbridge4 stop") // legacy issue to use bitbridge4
        require('child_process').execSync("sudo service bitbridge6 stop") // legacy issue to use bitbridge4
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

  async ipv6On() {
    try {
      await exec("touch /home/pi/.firewalla/config/enablev6");
      await exec("sudo pkill bitbridge6");
    } catch(err) {
      log.warn("Error when turn on ipv6", err);
    }
  }

  async ipv6Off() {
    try {
      await exec("rm -f /home/pi/.firewalla/config/enablev6");
      await exec("sudo pkill bitbridge6");
    } catch(err) {
      log.warn("Error when turn off ipv6", err);
    }
  }
}

module.exports = BitBridge
