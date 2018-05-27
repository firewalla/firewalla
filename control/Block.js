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
const Promise = require('bluebird');

let iptool = require("ip");

let inited = false;

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const AUTO_ROLLBACK_TIME= 3600 * 1000; // in one hour, dns cache should already invalidated after one hour

const exec = require('child-process-promise').exec

const f = require('../net2/Firewalla.js')

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
  log.info("Setting up iptables for traffic blocking");
  let cmd = __dirname + "/install_iptables_setup.sh";

  // FIXME: ignore if failed or not
  cp.execSync(cmd);

  async(() => {
    setupCategoryEnv("games");
    setupCategoryEnv("porn");
    setupCategoryEnv("social");
    setupCategoryEnv("shopping");
    setupCategoryEnv("av");
    setupCategoryEnv("default_c");
  })()

  inited = true;
}

function getMacSet(tag) {
  return `c_bm_${tag}_set`
}

function getDstSet(tag) {
  return `c_bd_${tag}_set`
}

function getDstSet6(tag) {
  return `c_bd_${tag}_set6`
}

function setupBlockingEnv(tag) {
  if(!tag) {
    return Promise.resolve()
  }

  // sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536
  return async(() => {
    const macSet = getMacSet(tag)
    const dstSet = getDstSet(tag)
    const dstSet6 = getDstSet6(tag)

    const cmdCreateMacSet = `sudo ipset create -! ${macSet} hash:mac`
    const cmdCreateDstSet = `sudo ipset create -! ${dstSet} hash:ip family inet hashsize 128 maxelem 65536`
    const cmdCreateDstSet6 = `sudo ipset create -! ${dstSet6} hash:ip family inet6 hashsize 128 maxelem 65536`
    const cmdCreateOutgoingRule = `sudo iptables -C FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j DROP || sudo iptables -I FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j DROP`
    const cmdCreateIncomingRule = `sudo iptables -C FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j DROP || sudo iptables -I FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j DROP`
    const cmdCreateOutgoingTCPRule = `sudo iptables -C FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j REJECT || sudo iptables -I FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j REJECT`
    const cmdCreateIncomingTCPRule = `sudo iptables -C FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j REJECT || sudo iptables -I FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j REJECT`
    const cmdCreateOutgoingRule6 = `sudo ip6tables -C FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j DROP || sudo ip6tables -I FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j DROP`
    const cmdCreateIncomingRule6 = `sudo ip6tables -C FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j DROP || sudo ip6tables -I FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j DROP`
    const cmdCreateOutgoingTCPRule6 = `sudo ip6tables -C FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j REJECT || sudo ip6tables -I FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j REJECT`
    const cmdCreateIncomingTCPRule6 = `sudo ip6tables -C FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j REJECT || sudo ip6tables -I FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j REJECT`

    await (exec(cmdCreateMacSet))
    await (exec(cmdCreateDstSet))
    await (exec(cmdCreateDstSet6))
    await (exec(cmdCreateOutgoingRule))
    await (exec(cmdCreateIncomingRule))
    await (exec(cmdCreateOutgoingTCPRule))
    await (exec(cmdCreateIncomingTCPRule))
    await (exec(cmdCreateOutgoingRule6))
    await (exec(cmdCreateIncomingRule6))
    await (exec(cmdCreateOutgoingTCPRule6))
    await (exec(cmdCreateIncomingTCPRule6))
  })().catch(err => {
    log.error('Error when setup blocking env', err);
  })
}

function setupCategoryEnv(category) {
  if(!category) {
    return Promise.resolve()
  }

  const cmdCreateCategorySet = `sudo ipset create -! c_category_${category} hash:ip family inet hashsize 128 maxelem 65536`
  const cmdCreateCategorySet6 = `sudo ipset create -! c_category6_${category} hash:ip family inet6 hashsize 128 maxelem 65536`
  const cmdCreateTempCategorySet = `sudo ipset create -! c_tmp_category_${category} hash:ip family inet hashsize 128 maxelem 65536`
  const cmdCreateTempCategorySet6 = `sudo ipset create -! c_tmp_category6_${category} hash:ip family inet6 hashsize 128 maxelem 65536`

  return async(() => {
    await (exec(cmdCreateCategorySet))
    await (exec(cmdCreateCategorySet6))
    await (exec(cmdCreateTempCategorySet))
    await (exec(cmdCreateTempCategorySet6))
  })()
}

function existsBlockingEnv(tag) {
  const cmd = `sudo iptables -L FW_BLOCK | grep ${getMacSet(tag)} | wc -l`
  return async(() => {
    let output = await (exec(cmd))
    if(output.stdout == 4) {
      return true
    } else {
      return false
    }
  })().catch(err => {
    log.error('Error when check blocking env existence', err);
  })
}

function destroyBlockingEnv(tag) {
  if(!tag) {
    return Promise.resolve()
  }

  // sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536
  return async(() => {
    log.info("destroying block enviornment for", tag)
    
    const macSet = getMacSet(tag)
    const dstSet = getDstSet(tag)
    const dstSet6 = getDstSet6(tag)

    const cmdDeleteOutgoingRule6 = `sudo ip6tables -D FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j DROP`
    const cmdDeleteIncomingRule6 = `sudo ip6tables -D FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j DROP`
    const cmdDeleteOutgoingTCPRule6 = `sudo ip6tables -D FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j REJECT`
    const cmdDeleteIncomingTCPRule6 = `sudo ip6tables -D FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j REJECT`
    const cmdDeleteOutgoingRule = `sudo iptables -D FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j DROP`
    const cmdDeleteIncomingRule = `sudo iptables -D FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j DROP`
    const cmdDeleteOutgoingTCPRule = `sudo iptables -D FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j REJECT`
    const cmdDeleteIncomingTCPRule = `sudo iptables -D FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j REJECT`
    const cmdDeleteMacSet = `sudo ipset destroy ${macSet}`
    const cmdDeleteDstSet = `sudo ipset destroy ${dstSet}`
    const cmdDeleteDstSet6 = `sudo ipset destroy ${dstSet6}`

    await (exec(cmdDeleteOutgoingRule6))
    await (exec(cmdDeleteIncomingRule6))
    await (exec(cmdDeleteOutgoingTCPRule6))
    await (exec(cmdDeleteIncomingTCPRule6))
    await (exec(cmdDeleteOutgoingRule))
    await (exec(cmdDeleteIncomingRule))
    await (exec(cmdDeleteOutgoingTCPRule))
    await (exec(cmdDeleteIncomingTCPRule))
    await (exec(cmdDeleteMacSet))
    await (exec(cmdDeleteDstSet))
    await (exec(cmdDeleteDstSet6))

    log.info("finish destroying block enviornment for", tag)
  })().catch(err => {
    log.error('Error when destroy blocking env', err);
  })
}

let ipsetQueue = [];
let maxIpsetQueue = 158;
let ipsetInterval = 3000;
let ipsetTimerSet = false;
let ipsetProcessing = false;

function ipsetEnqueue(ipsetCmd) {
  if (ipsetCmd != null) {
    ipsetQueue.push(ipsetCmd);
  }
  if (ipsetProcessing == false && ipsetQueue.length>0 && (ipsetQueue.length>maxIpsetQueue || ipsetCmd == null)) {
    ipsetProcessing = true;
    let _ipsetQueue = JSON.parse(JSON.stringify(ipsetQueue));
    ipsetQueue = [];
    let child = require('child_process').spawn('sudo',['ipset', 'restore', '-!']);
    child.stdin.setEncoding('utf-8');
    child.on('exit',(code,signal)=>{
      ipsetProcessing = false;
      log.info("Control:Block:Processing:END", code);
      ipsetEnqueue(null);
    });
    child.on('error',(code,signal)=>{
      ipsetProcessing = false;
      log.info("Control:Block:Processing:Error", code);
      ipsetEnqueue(null);
    });
    for (let i in _ipsetQueue) {
      log.info("Control:Block:Processing", _ipsetQueue[i]);
      child.stdin.write(_ipsetQueue[i]+"\n");
    }
    child.stdin.end();
    log.info("Control:Block:Processing:Launched", _ipsetQueue.length);
  } else {
    if (ipsetTimerSet == false) {
      setTimeout(()=>{
        if (ipsetQueue.length>0) {
          log.info("Control:Block:Timer", ipsetQueue.length);
          ipsetEnqueue(null);
        }
        ipsetTimerSet = false;
      },ipsetInterval);
      ipsetTimerSet = true;
    }
  }
}

function block(destination, ipset) {
  ipset = ipset || "blocked_ip_set"

  // never block black hole ip, they are already blocked in setup scripts
  if(f.isReservedBlockingIP(destination)) {
    return Promise.resolve()
  }
  
  let cmd = null;

  if(iptool.isV4Format(destination)) {
    cmd = `add -! ${ipset} ${destination}`
  } else if(iptool.isV6Format(destination)) {
    cmd = `add -! ${ipset}6 ${destination}`
  } else {
    // do nothing
    return Promise.resolve()
  }

  log.info("Control:Block:Enqueue", cmd);
  ipsetEnqueue(cmd);
  return Promise.resolve()
}

function blockImmediate(destination, ipset) {
  ipset = ipset || "blocked_ip_set"

  // never block black hole ip, they are already blocked in setup scripts
  if(f.isReservedBlockingIP(destination)) {
    return Promise.resolve()
  }
  
  let cmd = null;

  if(iptool.isV4Format(destination)) {
    cmd = `sudo ipset add -! ${ipset} ${destination}`
  } else if(iptool.isV6Format(destination)) {
    cmd = `sudo ipset add -! ${ipset}6 ${destination}`
  } else {
    // do nothing
    return Promise.resolve()
  }
  log.info("Control:Block:",cmd);

  return new Promise((resolve, reject) => {
    cp.exec(cmd, (err, stdout, stderr) => {
      if(err) {
        log.error("Unable to ipset add ",cmd);
        reject(err);
        return;
      }
      
      resolve();
    });
  });
}


function advancedBlock(tag, macAddresses, destinations) {
  return async(() => {
    await(setupBlockingEnv(tag))
    
    macAddresses.forEach((mac) => {
      await (advancedBlockMAC(mac, getMacSet(tag)))
    })
    destinations.forEach((addr) => {
      await (block(addr, getDstSet(tag)))
    })
  })()
}

function advancedUnblock(tag, macAddresses, destinations) {
  return async(() => {
    // macAddresses.forEach((mac) => {
    //   await (advancedUnblockMAC(mac, getMacSet(tag)))
    // })
    // destinations.forEach((addr) => {
    //   await (unblock(addr, getDstSet(tag)))
    // })
    await (destroyBlockingEnv(tag))
  })()
}

function advancedBlockMAC(macAddress, setName) {
  return async(() => {
    if(macAddress && setName) {
      const cmd = `sudo ipset add -! ${setName} ${macAddress}`
      return exec(cmd)
    } else {
      return Promise.reject(new Error(`Mac ${macAddress} or Set ${setName} not exists`))
    }
  })().catch(err => {
    log.error('Error when advancedBlockMAC', err);
  })
}

function advancedUnblockMAC(macAddress, setName) {
  return async(() => {
    if(macAddress && setName) {
      const cmd = `sudo ipset del ${setName} ${macAddress}`
      return exec(cmd)
    } else {
      return Promise.reject(new Error(`Mac ${macAddress} or Set ${setName} not exists`))
    }
  })().catch(err => {
    log.error('Error when advancedUnblockMAC', err);
  })
}

function unblock(destination, ipset) {
  ipset = ipset || "blocked_ip_set"

  // never unblock black hole ip
  if(f.isReservedBlockingIP(destination)) {
    return Promise.resolve()
  }
  
  let cmd = null;
  if(iptool.isV4Format(destination)) {
    cmd = `sudo ipset del -! ${ipset} ${destination}`
  } else if(iptool.isV6Format(destination)) {
    cmd = `sudo ipset del -! ${ipset}6 ${destination}`
  } else {
    // do nothing
  }

  log.info("Control:UnBlock:",cmd);

  return new Promise((resolve, reject) => {
    cp.exec(cmd, (err, stdout, stderr) => {
      if(err) {
        log.error("Unable to ipset remove ",cmd, err, {})
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
            log.debug(err, stdout, stderr);
            callback(err);        
          });
        }
      });
  } else {
      let delCMD = util.format("sudo %s -D FW_BLOCK --protocol all  %s -m mac --mac-source %s -j DROP", cmd, destinationStr, macAddress);
      cp.exec(delCMD, (err, stdout, stderr) => {
        log.debug(err, stdout, stderr);
        callback(err);        
      });
  }
}

function blockMac(macAddress, ipset) {
  ipset = ipset || "blocked_mac_set"

  let cmd = `sudo ipset add -! ${ipset} ${macAddress}`;
  
  log.info("Control:Block:",cmd);

  return exec(cmd)
}

function unblockMac(macAddress, ipset) {
  ipset = ipset || "blocked_mac_set"

  let cmd = `sudo ipset del -! ${ipset} ${macAddress}`;
  
  log.info("Control:Block:",cmd);

  return exec(cmd)
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
  advancedBlock: advancedBlock,
  advancedUnblock: advancedUnblock,
  blockPublicPort:blockPublicPort,
  unblockPublicPort: unblockPublicPort,
  setupBlockingEnv: setupBlockingEnv,
  getDstSet: getDstSet,
  getDstSet6: getDstSet6,
  getMacSet: getMacSet,
  existsBlockingEnv: existsBlockingEnv
}
