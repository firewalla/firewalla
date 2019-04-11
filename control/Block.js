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

const util = require('util');
const cp = require('child_process');
const log = require("../net2/logger.js")(__filename);

const iptool = require("ip");

const Accounting = require('./Accounting.js');
const accounting = new Accounting();

const exec = require('child-process-promise').exec

const f = require('../net2/Firewalla.js')

const WHITELIST_MARK = "0x1/0x1";

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

  setupCategoryEnv("games");
  setupCategoryEnv("porn");
  setupCategoryEnv("social");
  setupCategoryEnv("shopping");
  setupCategoryEnv("p2p");
  setupCategoryEnv("gamble");
  setupCategoryEnv("av");
  setupCategoryEnv("default_c");

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

async function enableGlobalWhitelist() {
  try {
    // mark all packets to divert to whitelist chain
    // Beware that _wrapIptables is not used here in purpose. Each global whitelist rule will create a MARK policy rule
    const cmdCreateMarkRule = `sudo iptables -w -t mangle -I PREROUTING -j CONNMARK --set-xmark ${WHITELIST_MARK}`;
    const cmdCreateMarkRule6 = `sudo ip6tables -w -t mangle -I PREROUTING -j CONNMARK --set-xmark ${WHITELIST_MARK}`;

    await exec(cmdCreateMarkRule);
    await exec(cmdCreateMarkRule6);
  } catch (err) {
    log.error("Failed to enable global whitelist");
  }
}

async function disableGlobalWhitelist() {
  try {
    // delete MARK policy rule in mangle table
    const cmdDeleteMarkRule = _wrapIptables(`sudo iptables -w -t mangle -D PREROUTING -j CONNMARK --set-xmark ${WHITELIST_MARK}`);
    const cmdDeleteMarkRule6 = _wrapIptables(`sudo ip6tables -w -t mangle -D PREROUTING -j CONNMARK --set-xmark ${WHITELIST_MARK}`);

    await exec(cmdDeleteMarkRule);
    await exec(cmdDeleteMarkRule6);
  } catch (err) {
    log.error("Failed to enable global whitelist");
  }
}

async function setupWhitelistEnv(macTag, dstTag) {
  if (!macTag || !dstTag) {
    return;
  }

  try {
    const macSet = getMacSet(macTag);
    const dstSet = getDstSet(dstTag);
    const dstSet6 = getDstSet6(dstTag);

    const cmdCreateMacSet = `sudo ipset create -! ${macSet} hash:mac`;
    const cmdCreateDstSet = `sudo ipset create -! ${dstSet} hash:ip family inet hashsize 128 maxelem 65536`;
    const cmdCreateDstSet6 = `sudo ipset create -! ${dstSet6} hash:ip family inet6 hashsize 128 maxelem 65536`;

    // mark packet in mangle table which indicates the packets need to go through the whitelist chain.
    // Use insert(-I) here since there is a clear mark rule at the end of the PREROUTING chain in mangle to allow all dns packets
    const cmdCreateMarkRule = _wrapIptables(`sudo iptables -w -t mangle -I PREROUTING -m set --match-set ${macSet} src -j CONNMARK --set-xmark ${WHITELIST_MARK}`);
    const cmdCreateMarkRule6 = _wrapIptables(`sudo ip6tables -w -t mangle -I PREROUTING -m set --match-set ${macSet} src -j CONNMARK --set-xmark ${WHITELIST_MARK}`);

    // add RETURN policy rule into whitelist chain
    const cmdCreateOutgoingRule = _wrapIptables(`sudo iptables -w -I FW_WHITELIST -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j RETURN`);
    const cmdCreateOutgoingRule6 = _wrapIptables(`sudo ip6tables -w -I FW_WHITELIST -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j RETURN`);
    // add corresponding whitelist rules into nat table
    const cmdCreateNatOutgoingTCPRule = _wrapIptables(`sudo iptables -w -t nat -I FW_NAT_WHITELIST -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j RETURN`);
    const cmdCreateNatOutgoingUDPRule = _wrapIptables(`sudo iptables -w -t nat -I FW_NAT_WHITELIST -p udp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j RETURN`);
    const cmdCreateNatOutgoingTCPRule6 = _wrapIptables(`sudo ip6tables -w -t nat -I FW_NAT_WHITELIST -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j RETURN`);
    const cmdCreateNatOutgoingUDPRule6 = _wrapIptables(`sudo ip6tables -w -t nat -I FW_NAT_WHITELIST -p udp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j RETURN`);

    await exec(cmdCreateMacSet);
    await exec(cmdCreateDstSet);
    await exec(cmdCreateDstSet6);
    await exec(cmdCreateMarkRule);
    await exec(cmdCreateOutgoingRule);
    await exec(cmdCreateMarkRule6);
    await exec(cmdCreateOutgoingRule6);
    await exec(cmdCreateNatOutgoingTCPRule);
    await exec(cmdCreateNatOutgoingUDPRule);
    await exec(cmdCreateNatOutgoingTCPRule6);
    await exec(cmdCreateNatOutgoingUDPRule6);
  } catch (err) {
    log.error('Error when setup whitelist env', err);
  }
}

async function setupBlockingEnv(macTag, dstTag) {
  if(!macTag || !dstTag) {
    return Promise.resolve()
  }

  // sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536
  try {
    const macSet = getMacSet(macTag)
    const dstSet = getDstSet(dstTag)
    const dstSet6 = getDstSet6(dstTag)

    const cmdCreateMacSet = `sudo ipset create -! ${macSet} hash:mac`
    const cmdCreateDstSet = `sudo ipset create -! ${dstSet} hash:ip family inet hashsize 128 maxelem 65536`
    const cmdCreateDstSet6 = `sudo ipset create -! ${dstSet6} hash:ip family inet6 hashsize 128 maxelem 65536`
    // add rules in filter table
    const cmdCreateOutgoingRule = _wrapIptables(`sudo iptables -w -I FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j DROP`)
    const cmdCreateIncomingRule = _wrapIptables(`sudo iptables -w -I FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j DROP`)
    const cmdCreateOutgoingTCPRule = _wrapIptables(`sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j REJECT`)
    const cmdCreateIncomingTCPRule = _wrapIptables(`sudo iptables -w -I FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j REJECT`)
    const cmdCreateOutgoingRule6 = _wrapIptables(`sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j DROP`)
    const cmdCreateIncomingRule6 = _wrapIptables(`sudo ip6tables -w -I FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j DROP`)
    const cmdCreateOutgoingTCPRule6 = _wrapIptables(`sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j REJECT`)
    const cmdCreateIncomingTCPRule6 = _wrapIptables(`sudo ip6tables -w -I FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j REJECT`)
    // add rules in nat table
    const cmdCreateNatOutgoingTCPRule = _wrapIptables(`sudo iptables -w -t nat -I FW_NAT_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j REDIRECT --to-ports 8888`)
    const cmdCreateNatOutgoingUDPRule = _wrapIptables(`sudo iptables -w -t nat -I FW_NAT_BLOCK -p udp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j REDIRECT --to-ports 8888`)
    const cmdCreateNatOutgoingTCPRule6 = _wrapIptables(`sudo ip6tables -w -t nat -I FW_NAT_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j REDIRECT --to-ports 8888`)
    const cmdCreateNatOutgoingUDPRule6 = _wrapIptables(`sudo ip6tables -w -t nat -I FW_NAT_BLOCK -p udp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j REDIRECT --to-ports 8888`)


    await exec(cmdCreateMacSet);
    await exec(cmdCreateDstSet);
    await exec(cmdCreateDstSet6);
    await exec(cmdCreateOutgoingRule);
    await exec(cmdCreateIncomingRule);
    await exec(cmdCreateOutgoingTCPRule);
    await exec(cmdCreateIncomingTCPRule);
    await exec(cmdCreateOutgoingRule6);
    await exec(cmdCreateIncomingRule6);
    await exec(cmdCreateOutgoingTCPRule6);
    await exec(cmdCreateIncomingTCPRule6);
    await exec(cmdCreateNatOutgoingTCPRule);
    await exec(cmdCreateNatOutgoingUDPRule);
    await exec(cmdCreateNatOutgoingTCPRule6);
    await exec(cmdCreateNatOutgoingUDPRule6);
  } catch(err) {
    log.error('Error when setup blocking env', err);
  }
}

async function setupCategoryEnv(category) {
  if(!category) {
    return;
  }

  const ipset = getDstSet(category);
  const tempIpset = getDstSet(`tmp_${category}`);
  const ipset6 = getDstSet6(category);
  const tempIpset6 = getDstSet6(`tmp_${category}`);

  const cmdCreateCategorySet = `sudo ipset create -! ${ipset} hash:ip family inet hashsize 128 maxelem 65536`
  const cmdCreateCategorySet6 = `sudo ipset create -! ${ipset6} hash:ip family inet6 hashsize 128 maxelem 65536`
  const cmdCreateTempCategorySet = `sudo ipset create -! ${tempIpset} hash:ip family inet hashsize 128 maxelem 65536`
  const cmdCreateTempCategorySet6 = `sudo ipset create -! ${tempIpset6} hash:ip family inet6 hashsize 128 maxelem 65536`

  await exec(cmdCreateCategorySet);
  await exec(cmdCreateCategorySet6);
  await exec(cmdCreateTempCategorySet);
  await exec(cmdCreateTempCategorySet6);
}

async function existsBlockingEnv(tag) {
  const cmd = `sudo iptables -w -L FW_BLOCK | grep ${getMacSet(tag)} | wc -l`
  try {
    let output = await exec(cmd);
    if(output.stdout == 4) {
      return true
    } else {
      return false
    }
  } catch(err) {
    log.error('Error when check blocking env existence', err);
  }
}

async function destroyWhitelistEnv(macTag, dstTag, destroyDstCache) {
  if (!macTag || !dstTag) {
    return;
  }

  try {
    log.info("Destorying whitelist environment for ", macTag, dstTag);
    const macSet = getMacSet(macTag);
    const dstSet = getDstSet(dstTag);
    const dstSet6 = getDstSet6(dstTag);

    // delete MARK policy rule in mangle table
    const cmdDeleteMarkRule = _wrapIptables(`sudo iptables -w -t mangle -D PREROUTING -m set --match-set ${macSet} src -j CONNMARK --set-xmark ${WHITELIST_MARK}`);

    const cmdDeleteMarkRule6 = _wrapIptables(`sudo ip6tables -w -t mangle -D PREROUTING -m set --match-set ${macSet} src -j CONNMARK --set-xmark ${WHITELIST_MARK}`);

    // delete RETURN policy rule in whitelist chain
    const cmdDeleteOutgoingRule = _wrapIptables(`sudo iptables -w -D FW_WHITELIST -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j RETURN`);
    const cmdDeleteOutgoingRule6 = _wrapIptables(`sudo ip6tables -w -D FW_WHITELIST -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j RETURN`);
    // delete corresponding whitelist rules in nat table
    const cmdDeleteNatOutgoingTCPRule = _wrapIptables(`sudo iptables -w -t nat -D FW_NAT_WHITELIST -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j RETURN`);
    const cmdDeleteNatOutgoingUDPRule = _wrapIptables(`sudo iptables -w -t nat -D FW_NAT_WHITELIST -p udp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j RETURN`);
    const cmdDeleteNatOutgoingTCPRule6 = _wrapIptables(`sudo ip6tables -w -t nat -D FW_NAT_WHITELIST -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j RETURN`);
    const cmdDeleteNatOutgoingUDPRule6 = _wrapIptables(`sudo ip6tables -w -t nat -D FW_NAT_WHITELIST -p udp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j RETURN`);

    const cmdDeleteMacSet = `sudo ipset destroy ${macSet}`;
    const cmdDeleteDstSet = `sudo ipset destroy ${dstSet}`;
    const cmdDeleteDstSet6 = `sudo ipset destroy ${dstSet6}`;

    await exec(cmdDeleteMarkRule);
    await exec(cmdDeleteMarkRule6);
    await exec(cmdDeleteOutgoingRule);
    await exec(cmdDeleteOutgoingRule6);
    await exec(cmdDeleteNatOutgoingTCPRule);
    await exec(cmdDeleteNatOutgoingUDPRule);
    await exec(cmdDeleteNatOutgoingTCPRule6);
    await exec(cmdDeleteNatOutgoingUDPRule6);
    if (!await _isIpsetReferenced(macSet))
      await exec(cmdDeleteMacSet);
    if (!await _isIpsetReferenced(dstSet) && destroyDstCache)
      await exec(cmdDeleteDstSet);
    if (!await _isIpsetReferenced(dstSet6) && destroyDstCache)
      await exec(cmdDeleteDstSet6);

    log.info("Finish destroying whitelist environment for ", macTag, dstTag);
  } catch (err) {
    log.error("Error when destroy whitelist env", err);
  }
}

async function _isIpsetReferenced(ipset) {
  const listCommand = `sudo ipset list ${ipset} | grep References | cut -d ' ' -f 2`;
  const result = await exec(listCommand);
  const referenceCount = result.stdout;
  return referenceCount !== "0";
}

async function destroyBlockingEnv(macTag, dstTag, destroyDstCache) {
  if(!macTag || !dstTag) {
    return;
  }

  // sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536
  try {
    log.info("Destroying block environment for ", macTag, dstTag)

    const macSet = getMacSet(macTag)
    const dstSet = getDstSet(dstTag)
    const dstSet6 = getDstSet6(dstTag)

    // delete rules in filter table
    const cmdDeleteOutgoingRule6 = _wrapIptables(`sudo ip6tables -w -D FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j DROP`)
    const cmdDeleteIncomingRule6 = _wrapIptables(`sudo ip6tables -w -D FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j DROP`)
    const cmdDeleteOutgoingTCPRule6 = _wrapIptables(`sudo ip6tables -w -D FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j REJECT`)
    const cmdDeleteIncomingTCPRule6 = _wrapIptables(`sudo ip6tables -w -D FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet6} src -j REJECT`)
    const cmdDeleteOutgoingRule = _wrapIptables(`sudo iptables -w -D FW_BLOCK -p all -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j DROP`)
    const cmdDeleteIncomingRule = _wrapIptables(`sudo iptables -w -D FW_BLOCK -p all -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j DROP`)
    const cmdDeleteOutgoingTCPRule = _wrapIptables(`sudo iptables -w -D FW_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j REJECT`)
    const cmdDeleteIncomingTCPRule = _wrapIptables(`sudo iptables -w -D FW_BLOCK -p tcp -m set --match-set ${macSet} dst -m set --match-set ${dstSet} src -j REJECT`)
    // delete rules in nat table
    const cmdDeleteNatOutgoingTCPRule = _wrapIptables(`sudo iptables -w -t nat -D FW_NAT_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j REDIRECT --to-ports 8888`);
    const cmdDeleteNatOutgoingUDPRule = _wrapIptables(`sudo iptables -w -t nat -D FW_NAT_BLOCK -p udp -m set --match-set ${macSet} src -m set --match-set ${dstSet} dst -j REDIRECT --to-ports 8888`);
    const cmdDeleteNatOutgoingTCPRule6 = _wrapIptables(`sudo ip6tables -w -t nat -D FW_NAT_BLOCK -p tcp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j REDIRECT --to-ports 8888`);
    const cmdDeleteNatOutgoingUDPRule6 = _wrapIptables(`sudo ip6tables -w -t nat -D FW_NAT_BLOCK -p udp -m set --match-set ${macSet} src -m set --match-set ${dstSet6} dst -j REDIRECT --to-ports 8888`);
    // destroy ipsets if necessary
    const cmdDeleteMacSet = `sudo ipset destroy ${macSet}`
    const cmdDeleteDstSet = `sudo ipset destroy ${dstSet}`
    const cmdDeleteDstSet6 = `sudo ipset destroy ${dstSet6}`

    await exec(cmdDeleteOutgoingRule6);
    await exec(cmdDeleteIncomingRule6);
    await exec(cmdDeleteOutgoingTCPRule6);
    await exec(cmdDeleteIncomingTCPRule6);
    await exec(cmdDeleteOutgoingRule);
    await exec(cmdDeleteIncomingRule);
    await exec(cmdDeleteOutgoingTCPRule);
    await exec(cmdDeleteIncomingTCPRule);
    await exec(cmdDeleteNatOutgoingTCPRule);
    await exec(cmdDeleteNatOutgoingUDPRule);
    await exec(cmdDeleteNatOutgoingTCPRule6);
    await exec(cmdDeleteNatOutgoingUDPRule6);
    if (!await _isIpsetReferenced(macSet) && destroyDstCache)
      await exec(cmdDeleteMacSet);
    if (!await _isIpsetReferenced(dstSet) && destroyDstCache)
      await exec(cmdDeleteDstSet);
    if (!await _isIpsetReferenced(dstSet6) && destroyDstCache)
      await exec(cmdDeleteDstSet6);

    log.info("Finish destroying block environment for ", macTag, dstTag)
  } catch(err) {
    log.error('Error when destroy blocking env', err);
  }
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
      log.debug("Control:Block:Processing", _ipsetQueue[i]);
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

async function block(destination, ipset) {
  ipset = ipset || "blocked_ip_set"

  // never block black hole ip, they are already blocked in setup scripts
  if(f.isReservedBlockingIP(destination)) {
    return;
  }

  let cmd = null;

  if(iptool.isV4Format(destination)) {
    cmd = `add -! ${ipset} ${destination}`
  } else if(iptool.isV6Format(destination)) {
    cmd = `add -! ${ipset}6 ${destination}`
  } else {
    // do nothing
    return;
  }

  log.debug("Control:Block:Enqueue", cmd);
  ipsetEnqueue(cmd);
  return;
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


async function advancedBlock(macTag, dstTag, macAddresses, destinations, whitelist) {
  if (whitelist) {
    await setupWhitelistEnv(macTag, dstTag);
  } else {
    await setupBlockingEnv(macTag, dstTag);
  }

  for (const mac of macAddresses) {
    await advancedBlockMAC(mac, getMacSet(macTag));
  }
  for (const addr of destinations) {
    await block(addr, getDstSet(dstTag))
  }
}

async function advancedUnblock(macTag, dstTag, macAddresses, destinations, whitelist, destroyDstCache) {
  // macAddresses.forEach((mac) => {
  //   await (advancedUnblockMAC(mac, getMacSet(tag)))
  // })
  // destinations.forEach((addr) => {
  //   await (unblock(addr, getDstSet(tag)))
  // })
  if (whitelist) {
    await destroyWhitelistEnv(macTag, dstTag, destroyDstCache);
  } else {
    await destroyBlockingEnv(macTag, dstTag, destroyDstCache);
  }
}

async function advancedBlockMAC(macAddress, setName) {
  try {
    if (macAddress && setName) {
      const cmd = `sudo ipset add -! ${setName} ${macAddress}`
      return exec(cmd)
    } else {
      throw new Error(`Mac ${macAddress} or Set ${setName} not exists`)
    }
  } catch(err) {
    log.error('Error when advancedBlockMAC', err);
  }
}

async function advancedUnblockMAC(macAddress, setName) {
  try {
    if (macAddress && setName) {
      const cmd = `sudo ipset -! del ${setName} ${macAddress}`
      return exec(cmd)
    } else {
      throw new Error(`Mac ${macAddress} or Set ${setName} not exists`)
    }
  } catch(err) {
    log.error('Error when advancedUnblockMAC', err);
  }
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

  accounting.addBlockedDevice(macAddress);

  return exec(cmd)
}

function unblockMac(macAddress, ipset) {
  ipset = ipset || "blocked_mac_set"

  let cmd = `sudo ipset del -! ${ipset} ${macAddress}`;

  log.info("Control:Block:",cmd);

  accounting.removeBlockedDevice(macAddress);

  return exec(cmd)
}

function blockPublicPort(localIPAddress, localPort, protocol, ipset) {
  ipset = ipset || "blocked_ip_port_set";
  log.info("Blocking public port:", localIPAddress, localPort, protocol, ipset);
  protocol = protocol || "tcp";

  let entry = util.format("%s,%s:%s", localIPAddress, protocol, localPort);
  let cmd = null;

  if(iptool.isV4Format(localIPAddress)) {
    cmd = `sudo ipset add -! ${ipset} ${entry}`
  } else {
    cmd = `sudo ipset add -! ${ipset}6 ${entry}`
  }

  let execAsync = Promise.promisify(cp.exec);

  return execAsync(cmd);
}

function unblockPublicPort(localIPAddress, localPort, protocol, ipset) {
  ipset = ipset || "blocked_ip_port_set";
  log.info("Unblocking public port:", localIPAddress, localPort, protocol, {});
  protocol = protocol || "tcp";

  let entry = util.format("%s,%s:%s", localIPAddress, protocol, localPort);
  let cmd = null;

  if(iptool.isV4Format(localIPAddress)) {
    cmd = `sudo ipset del -! ${ipset} ${entry}`
  } else {
    cmd = `sudo ipset del -! ${ipset}6 ${entry}`
  }

  let execAsync = Promise.promisify(cp.exec);

  return execAsync(cmd);
}

function _wrapIptables(rule) {
  let command = " -I ";
  let checkRule = null;

  if(rule.indexOf(command) > -1) {
    checkRule = rule.replace(command, " -C ");
  }

  command = " -A ";
  if(rule.indexOf(command) > -1) {
    checkRule = rule.replace(command, " -C ");
  }

  command = " -D ";
  if(rule.indexOf(command) > -1) {
    checkRule = rule.replace(command, " -C ");
    return `bash -c '${checkRule} &>/dev/null && ${rule}'`;
  }

  if(checkRule) {
    return `bash -c '${checkRule} &>/dev/null || ${rule}'`;
  } else {
    return rule;
  }
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
  existsBlockingEnv: existsBlockingEnv,
  enableGlobalWhitelist: enableGlobalWhitelist,
  disableGlobalWhitelist: disableGlobalWhitelist
}
