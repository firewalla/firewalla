/*    Copyright 2016 Rottiesoft LLC 
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

let util = require('util');
let cp = require('child_process');
let path = require('path');
let log = require("./logger.js")(path.basename(__filename));


// =============== block @ connection level ==============

// Block every connection initiated from one local machine to a remote ip address
function blockOutgoing(macAddress, destination, callback) {
  let checkCMD = util.format("sudo iptables -C FORWARD --protocol all --destination %s -m mac --mac-source %s -j REJECT", destination, macAddress);
  let addCMD = util.format("sudo iptables -A FORWARD --protocol all --destination %s -m mac --mac-source %s -j REJECT", destination, macAddress);

  cp.exec(checkCMD, (err, stdout, stderr) => {
    if(err) {
      log.info("BLOCK:OUTGOING==> ", addCMD);
      cp.exec(addCMD, (err, stdout, stderr) => {
        console.log(err, stdout, stderr);
        callback(err);        
      });
    }
  });
}

module.exports = {
  blockOutgoing : blockOutgoing
}
