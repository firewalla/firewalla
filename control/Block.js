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

let util = require('util');
let cp = require('child_process');
let path = require('path');
let log = require("../net2/logger.js")(__filename);
let Promise = require('bluebird');

let iptool = require("ip");

let inited = false;

// =============== block @ connection level ==============

function getIPTablesCmd(v6) {
  let cmd = "iptables";

  if(v6) {
    cmd = "ip6tables";
  }

  return cmd;
}

// This function MUST be called at the beginning of main.js
function setupBlockChain() {
  let cmd = __dirname + "/install_iptables_setup.sh";

  // FIXME: ignore if failed or not
  cp.execSync(cmd);

  inited = true;
}

function block(destination) {
  let cmd = null;

  if(iptool.isV4Format(destination)) {
    cmd = "sudo ipset add -! blocked_ip_set " + destination;    
  } else {
    cmd = "sudo ipset add -! blocked_ip_set6 " + destination;
  }

  return new Promise((resolve, reject) => {
    cp.exec(cmd, (err, stdout, stderr) => {
      if(err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

function unblock(destination) {
  let cmd = null;
  if(iptool.isV4Format(destination)) {
    cmd = "sudo ipset del -! blocked_ip_set " + destination;
  } else {
    cmd = "sudo ipset del -! blocked_ip_set6 " + destination;
  }

  return new Promise((resolve, reject) => {
    cp.exec(cmd, (err, stdout, stderr) => {
      if(err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

// Block every connection initiated from one local machine to a remote ip address
function blockOutgoing(macAddress, destination, state, v6, callback) {

  let destinationStr = ""

  let cmd = getIPTablesCmd(v6);
  
  if (destination) {
     let destinationStr = " --destination "+destination;
  }

  if (state == true) {
      let checkCMD = util.format("sudo %s -C FW_BLOCK --protocol all %s  -m mac --mac-source %s -j DROP", cmd, destinationStr, macAddress);
      let addCMD = util.format("sudo %s -I FW_BLOCK --protocol all %s  -m mac --mac-source %s -j DROP", cmd, destinationStr, macAddress);

      cp.exec(checkCMD, (err, stdout, stderr) => {
        if(err) {
          log.info("BLOCK:OUTGOING==> ", addCMD);
          cp.exec(addCMD, (err, stdout, stderr) => {
            log.info(err, stdout, stderr);
            callback(err);        
          });
        }
      });
  } else {
      let delCMD = util.format("sudo %s -D FW_BLOCK --protocol all  %s -m mac --mac-source %s -j DROP", cmd, destinationStr, macAddress);
      cp.exec(delCMD, (err, stdout, stderr) => {
        log.info(err, stdout, stderr);
        callback(err);        
      });
  }
}

function unblockMac(macAddress, callback) {
  callback = callback || function() {}

  blockOutgoing(macAddress,null,false,false, (err)=>{
    blockOutgoing(macAddress,null,false,true, (err)=>{
      callback(err);
    });
  });  
}

function blockMac(macAddress,callback) {
  callback = callback || function() {}

  blockOutgoing(macAddress,null,true,false, (err)=>{
    blockOutgoing(macAddress,null,true,true, (err)=>{
      callback(err);
    });
  });
}

function blockPublicPort(localIPAddress, localPort, protocol) {
  log.info("Blocking public port:", localIPAddress, localPort, protocol, {});
  protocol = protocol || "tcp";

  let entry = util.format("%s,%s:%s", localIPAddress, protocol, localPort);
  let cmd = null;
  
  if(iptool.isV4Format(localIPAddress)) {
    cmd = "sudo ipset add -! blocked_ip_port_set " + entry
  } else {
    cmd = "sudo ipset add -! blocked_ip_port_set6 " + entry
  }

  let execAsync = Promise.promisify(cp.exec);
  
  return execAsync(cmd);
}

function unblockPublicPort(localIPAddress, localPort, protocol) {
  log.info("Unblocking public port:", localIPAddress, localPort, protocol, {});
  protocol = protocol || "tcp";

  let entry = util.format("%s,%s:%s", localIPAddress, protocol, localPort);
  let cmd = null;
  
  if(iptool.isV4Format(localIPAddress)) {
    cmd = "sudo ipset del -! blocked_ip_port_set " + entry
  } else {
    cmd = "sudo ipset del -! blocked_ip_port_set6 " + entry
  }

  let execAsync = Promise.promisify(cp.exec);
  
  return execAsync(cmd);
}

module.exports = {
  setupBlockChain:setupBlockChain,
  blockOutgoing : blockOutgoing,
  blockMac: blockMac,
  unblockMac: unblockMac,
  block: block,
  unblock: unblock,
  blockPublicPort:blockPublicPort,
  unblockPublicPort:unblockPublicPort
}
