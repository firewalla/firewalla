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

let ngSpoofBinary = __dirname + "/../bin/bitbridge7";
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
      
      spawnProcess = spawn(ngSpoofBinary, [ifName, routerIP, myIP]);
      log.info("starting new spoofing: ", ngSpoofBinary, [ifName, routerIP, myIP], {});

      spawnProcess.stdout.pipe(logStream);
      spawnProcess.stderr.pipe(logStream);

      spawnProcess.on('close', (code) => {
        log.info("spoofing binary exited with code " + code);
      });

      spoofStarted = true;
      return Promise.resolve();

    });
  
}

module.exports = {
  startSpoofing: startSpoofing
}
