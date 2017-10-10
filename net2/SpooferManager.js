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

let firewalla = require('./Firewalla.js');

var spawn = require('child_process').spawn;

let spawnProcess = null;

let spoofLogFile = firewalla.getLogFolder() + "/spoof.log";

let SysManager = require("./SysManager.js");
let sysManager = new SysManager();

let Promise = require('bluebird');

let redis = require('redis');
let rclient = redis.createClient();

let log = require("./logger.js")(__filename, 'info');

let fs = require('fs');

let cp = require('child_process');

let monitoredKey = "monitored_hosts";
let unmonitoredKey = "unmonitored_hosts";

let spoofStarted = false;

// add promises to all redis functions
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

function getBinary() {
  if(firewalla.getPlatform() === "x86_64") {
    return firewalla.getFirewallaHome() + "/bin/real.x86_64/bitbridge7";
  }
  
  return firewalla.getFirewallaHome() + "/bin/bitbridge7";
}

// WORKAROUND VERSION HERE, will move to a better place
function startSpoofing() {

  if(spoofStarted) {
    return Promise.resolve();
  }
  
  // clean up redis key
  log.info("startSpoofing is called");
  
  return rclient.delAsync(monitoredKey)
    .then(() => rclient.delAsync(unmonitoredKey))
    .then(() => {
      let ifName = sysManager.monitoringInterface().name;
      let routerIP = sysManager.myGateway();
      let myIP = sysManager.myIp();
      
      if(!ifName || !myIP || !routerIP) {
        return Promise.reject("require valid interface name, ip address and gateway ip address");
      }

      if (firewalla.isProduction()) {
          spoofLogFile="/dev/null";
      }

      let logStream = fs.createWriteStream(spoofLogFile, {flags: 'a'});
      let binary = null, args = null;

      if(firewalla.isDocker() || firewalla.isTravis()) {
        binary = "sudo";
        args = [getBinary(), ifName, routerIP, myIP,'-m','-q','-n'];
      } else {
        binary = getBinary();
        args = [ifName, routerIP, myIP,'-m','-q','-n'];
      }

      let cmd = binary+" "+args.join(" ")
      log.info("Lanching Bitbridge4 ", cmd);
      require('child_process').execSync("echo '"+cmd +" ' > /home/pi/firewalla/bin/bitbridge4.sh");
      require('child_process').execSync("sudo service bitbridge4 restart");
      spoofStarted = true;
      return Promise.resolve();
    });
  
}

function stopSpoofing() {
  return new Promise((resolve, reject) => {
    spoofStarted = false;
    log.info("Killing Bitbridge4");
    require('child_process').exec("sudo service bitbridge4 stop",(err)=>{
      resolve();
    });
  }).catch((err) => {
    //catch everything here
  })
}

module.exports = {
  startSpoofing: startSpoofing,
  stopSpoofing: stopSpoofing
}
