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
const log = require("../net2/logger.js")(__filename);

const iptool = require("ip");

const Accounting = require('./Accounting.js');
const accounting = new Accounting();

const exec = require('child-process-promise').exec

const f = require('../net2/Firewalla.js')

const _wrapIptables = require('../net2/Iptables.js').wrapIptables;

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
async function setupBlockChain() {
  log.info("Setting up iptables for traffic blocking");
  let cmd = __dirname + "/install_iptables_setup.sh";

  await exec(cmd);

  await Promise.all([
    setupCategoryEnv("games"),
    setupCategoryEnv("porn"),
    setupCategoryEnv("social"),
    setupCategoryEnv("shopping"),
    setupCategoryEnv("p2p"),
    setupCategoryEnv("gamble"),
    setupCategoryEnv("av"),
    setupCategoryEnv("default_c"),
  ])

  log.info("Finished setup for traffic blocking");
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
    // so on removing we could delete one each time, and this will still be effective until all whitelist rules are removed
    // possible performance impact on packet filtering here?
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

async function setupWhitelistEnv(macTag, dstTag, dstType = "hash:ip", destroy = false, destroyDstCache = true) {
  if (!dstTag) {
    return;
  }

  try {
    log.info(destroy ? 'Destroying' : 'Creating', 'whitelist environment for', macTag || "null", dstTag,
      destroy && destroyDstCache ? "and ipset" : "");

    const macSet = macTag ? getMacSet(macTag) : '';
    const dstSet = getDstSet(dstTag);
    const dstSet6 = getDstSet6(dstTag);

    if (!destroy) {
      if (macTag) {
        const cmdCreateMacSet = `sudo ipset create -! ${macSet} hash:mac`
        await exec(cmdCreateMacSet);
      } else {
        await this.enableGlobalWhitelist();
      }
      const cmdCreateDstSet = `sudo ipset create -! ${dstSet} ${dstType} family inet hashsize 128 maxelem 65536`;
      const cmdCreateDstSet6 = `sudo ipset create -! ${dstSet6} ${dstType} family inet6 hashsize 128 maxelem 65536`;
      await exec(cmdCreateDstSet);
      await exec(cmdCreateDstSet6);
    }

    const ops = destroy ? '-D' : '-I'
    const matchMacSrc = macTag ? `-m set --match-set ${macSet} src` : '';

    // mark packet in mangle table which indicates the packets need to go through the whitelist chain.
    // Use insert(-I) here since there is a clear mark rule at the end of the PREROUTING chain in mangle to allow all dns packets
    const cmdMarkRule = _wrapIptables(`sudo iptables -w -t mangle ${ops} PREROUTING ${matchMacSrc} -j CONNMARK --set-xmark ${WHITELIST_MARK}`);
    const cmdMarkRule6 = _wrapIptables(`sudo ip6tables -w -t mangle ${ops} PREROUTING ${matchMacSrc} -j CONNMARK --set-xmark ${WHITELIST_MARK}`);

    // add RETURN policy rule into whitelist chain
    const cmdOutgoingRule = _wrapIptables(`sudo iptables -w ${ops} FW_WHITELIST -p all ${matchMacSrc} -m set --match-set ${dstSet} dst -j RETURN`);
    const cmdOutgoingRule6 = _wrapIptables(`sudo ip6tables -w ${ops} FW_WHITELIST -p all ${matchMacSrc} -m set --match-set ${dstSet6} dst -j RETURN`);
    // add corresponding whitelist rules into nat table
    const cmdNatOutgoingTCPRule = _wrapIptables(`sudo iptables -w -t nat ${ops} FW_NAT_WHITELIST -p tcp ${matchMacSrc} -m set --match-set ${dstSet} dst -j RETURN`);
    const cmdNatOutgoingUDPRule = _wrapIptables(`sudo iptables -w -t nat ${ops} FW_NAT_WHITELIST -p udp ${matchMacSrc} -m set --match-set ${dstSet} dst -j RETURN`);
    const cmdNatOutgoingTCPRule6 = _wrapIptables(`sudo ip6tables -w -t nat ${ops} FW_NAT_WHITELIST -p tcp ${matchMacSrc} -m set --match-set ${dstSet6} dst -j RETURN`);
    const cmdNatOutgoingUDPRule6 = _wrapIptables(`sudo ip6tables -w -t nat ${ops} FW_NAT_WHITELIST -p udp ${matchMacSrc} -m set --match-set ${dstSet6} dst -j RETURN`);

    await exec(cmdMarkRule);
    await exec(cmdOutgoingRule);
    await exec(cmdMarkRule6);
    await exec(cmdOutgoingRule6);
    await exec(cmdNatOutgoingTCPRule);
    await exec(cmdNatOutgoingUDPRule);
    await exec(cmdNatOutgoingTCPRule6);
    await exec(cmdNatOutgoingUDPRule6);

    if (destroy) {
      if (macTag) {
        if (!await _isIpsetReferenced(macSet)) {
          const cmdDeleteMacSet = `sudo ipset destroy ${macSet}`;
          await exec(cmdDeleteMacSet);
        }
      } else {
        await this.disableGlobalWhitelist();
      }
      if (destroyDstCache && !await _isIpsetReferenced(dstSet)) {
        const cmdDeleteDstSet = `sudo ipset destroy ${dstSet}`;
        await exec(cmdDeleteDstSet);
      }
      if (destroyDstCache && !await _isIpsetReferenced(dstSet6)) {
        const cmdDeleteDstSet6 = `sudo ipset destroy ${dstSet6}`;
        await exec(cmdDeleteDstSet6);
      }
    }

    log.info('Finish', destroy ? 'destroying' : 'creating', 'whitelist environment for', macTag || "null", dstTag);

  } catch (err) {
    log.error('Error when setup whitelist env', err);
  }
}

async function setupBlockingEnv(macTag, dstTag, dstType = "hash:ip", destroy = false, destroyDstCache = true) {
  if (!dstTag) {
    return;
  }

  // sudo ipset create blocked_ip_set hash:ip family inet hashsize 128 maxelem 65536
  try {
    log.info(destroy ? 'Destroying' : 'Creating', 'block environment for', macTag || "null", dstTag,
      destroy && destroyDstCache ? "and ipset" : "");

    const macSet = macTag ? getMacSet(macTag) : '';
    const dstSet = getDstSet(dstTag)
    const dstSet6 = getDstSet6(dstTag)

    if (!destroy) {
      if (macTag) {
        const cmdCreateMacSet = `sudo ipset create -! ${macSet} hash:mac`
        await exec(cmdCreateMacSet);
      }
      const cmdCreateDstSet = `sudo ipset create -! ${dstSet} ${dstType} family inet hashsize 128 maxelem 65536`
      const cmdCreateDstSet6 = `sudo ipset create -! ${dstSet6} ${dstType} family inet6 hashsize 128 maxelem 65536`
      await exec(cmdCreateDstSet);
      await exec(cmdCreateDstSet6);
    }

    const ops = destroy ? '-D' : '-I'
    const matchMacSrc = macTag ? `-m set --match-set ${macSet} src` : '';
    const matchMacDst = macTag ? `-m set --match-set ${macSet} dst` : '';

    // add rules in filter table
    const cmdOutgoingRule = _wrapIptables(`sudo iptables -w ${ops} FW_BLOCK -p all ${matchMacSrc} -m set --match-set ${dstSet} dst -j DROP`)
    const cmdIncomingRule = _wrapIptables(`sudo iptables -w ${ops} FW_BLOCK -p all ${matchMacDst} -m set --match-set ${dstSet} src -j DROP`)
    const cmdOutgoingTCPRule = _wrapIptables(`sudo iptables -w ${ops} FW_BLOCK -p tcp ${matchMacSrc} -m set --match-set ${dstSet} dst -j REJECT`)
    const cmdIncomingTCPRule = _wrapIptables(`sudo iptables -w ${ops} FW_BLOCK -p tcp ${matchMacDst} -m set --match-set ${dstSet} src -j REJECT`)
    const cmdOutgoingRule6 = _wrapIptables(`sudo ip6tables -w ${ops} FW_BLOCK -p all ${matchMacSrc} -m set --match-set ${dstSet6} dst -j DROP`)
    const cmdIncomingRule6 = _wrapIptables(`sudo ip6tables -w ${ops} FW_BLOCK -p all ${matchMacDst} -m set --match-set ${dstSet6} src -j DROP`)
    const cmdOutgoingTCPRule6 = _wrapIptables(`sudo ip6tables -w ${ops} FW_BLOCK -p tcp ${matchMacSrc} -m set --match-set ${dstSet6} dst -j REJECT`)
    const cmdIncomingTCPRule6 = _wrapIptables(`sudo ip6tables -w ${ops} FW_BLOCK -p tcp ${matchMacDst} -m set --match-set ${dstSet6} src -j REJECT`)
    // add rules in nat table
    const cmdNatOutgoingTCPRule = _wrapIptables(`sudo iptables -w -t nat ${ops} FW_NAT_BLOCK -p tcp ${matchMacSrc} -m set --match-set ${dstSet} dst -j REDIRECT --to-ports 8888`)
    const cmdNatOutgoingUDPRule = _wrapIptables(`sudo iptables -w -t nat ${ops} FW_NAT_BLOCK -p udp ${matchMacSrc} -m set --match-set ${dstSet} dst -j REDIRECT --to-ports 8888`)
    const cmdNatOutgoingTCPRule6 = _wrapIptables(`sudo ip6tables -w -t nat ${ops} FW_NAT_BLOCK -p tcp ${matchMacSrc} -m set --match-set ${dstSet6} dst -j REDIRECT --to-ports 8888`)
    const cmdNatOutgoingUDPRule6 = _wrapIptables(`sudo ip6tables -w -t nat ${ops} FW_NAT_BLOCK -p udp ${matchMacSrc} -m set --match-set ${dstSet6} dst -j REDIRECT --to-ports 8888`)

    await exec(cmdOutgoingRule);
    await exec(cmdIncomingRule);
    await exec(cmdOutgoingTCPRule);
    await exec(cmdIncomingTCPRule);
    await exec(cmdOutgoingRule6);
    await exec(cmdIncomingRule6);
    await exec(cmdOutgoingTCPRule6);
    await exec(cmdIncomingTCPRule6);
    await exec(cmdNatOutgoingTCPRule);
    await exec(cmdNatOutgoingUDPRule);
    await exec(cmdNatOutgoingTCPRule6);
    await exec(cmdNatOutgoingUDPRule6);

    if (destroy) {
      if (macTag && !await _isIpsetReferenced(macSet)) {
        const cmdDeleteMacSet = `sudo ipset destroy ${macSet}`
        await exec(cmdDeleteMacSet);
      }
      if (destroyDstCache && !await _isIpsetReferenced(dstSet)) {
        const cmdDeleteDstSet = `sudo ipset destroy ${dstSet}`
        await exec(cmdDeleteDstSet);
      }
      if (destroyDstCache && !await _isIpsetReferenced(dstSet6)) {
        const cmdDeleteDstSet6 = `sudo ipset destroy ${dstSet6}`
        await exec(cmdDeleteDstSet6);
      }
    }

    log.info('Finish', destroy ? 'destroying' : 'creating', 'block environment for', macTag || "null", dstTag);

  } catch(err) {
    log.error('Error when setup blocking env', err);
  }
}

async function setupCategoryEnv(category, dstType = "hash:ip") {
  if(!category) {
    return;
  }

  const ipset = getDstSet(category);
  const tempIpset = getDstSet(`tmp_${category}`);
  const ipset6 = getDstSet6(category);
  const tempIpset6 = getDstSet6(`tmp_${category}`);

  const cmdCreateCategorySet = `sudo ipset create -! ${ipset} ${dstType} family inet hashsize 128 maxelem 65536`
  const cmdCreateCategorySet6 = `sudo ipset create -! ${ipset6} ${dstType} family inet6 hashsize 128 maxelem 65536`
  const cmdCreateTempCategorySet = `sudo ipset create -! ${tempIpset} ${dstType} family inet hashsize 128 maxelem 65536`
  const cmdCreateTempCategorySet6 = `sudo ipset create -! ${tempIpset6} ${dstType} family inet6 hashsize 128 maxelem 65536`

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

async function _isIpsetReferenced(ipset) {
  const listCommand = `sudo ipset list ${ipset} | grep References | cut -d ' ' -f 2`;
  const result = await exec(listCommand);
  const referenceCount = result.stdout.trim();
  return referenceCount !== "0";
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
    let errorOccurred = false;
    child.stderr.on('data', (data) => {
      log.error("ipset restore error: " + data);
    });
    child.stdin.on('error', (err) =>{
      errorOccurred = true;
      log.error("Failed to write to stdin", err);
    });
    writeToStdin(0);
    function writeToStdin(i) {
      const stdinReady = child.stdin.write(_ipsetQueue[i] + "\n", (err) => {
        if (err) {
          errorOccurred = true;
          log.error("Failed to write to stdin", err);
        } else {
          if (i == _ipsetQueue.length - 1) {
            child.stdin.end();
          }
        }
      });
      if (!stdinReady) {
        child.stdin.once('drain', () => {
          if (i !== _ipsetQueue.length - 1 && !errorOccurred) {
            writeToStdin(i + 1);
          }
        });
      } else {
        if (i !== _ipsetQueue.length - 1 && !errorOccurred) {
          writeToStdin(i + 1);
        }
      }
    }
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

async function block(target, ipset, whitelist = false) {
  const slashIndex = target.indexOf('/')
  const ipAddr = slashIndex > 0 ? target.substring(0, slashIndex) : target;

  // default ipsets
  if (!ipset) {
    const prefix = whitelist ? 'whitelist' : 'blocked'
    const type = slashIndex > 0 ? 'net' : 'ip';
    ipset = `${prefix}_${type}_set`
  }

  // check and add v6 suffix
  let suffix = '';
  if (iptool.isV4Format(ipAddr)) {
    // ip.isV6Format() will return true on v4 addresses
  } else if (iptool.isV6Format(ipAddr)) {
    suffix = '6'
  } else {
    // do nothing
    return;
  }
  ipset = ipset + suffix;

  const cmd = `add -! ${ipset} ${target}`
  log.debug("Control:Block:Enqueue", cmd);
  ipsetEnqueue(cmd);
  return;
}

async function setupRules(macTag, dstTag, dstType, whitelist) {
  if (whitelist) {
    await setupWhitelistEnv(macTag, dstTag, dstType);
  } else {
    await setupBlockingEnv(macTag, dstTag, dstType);
  }
}

async function addMacToSet(macTag, macAddresses) {
  for (const mac of macAddresses || []) {
    await advancedBlockMAC(mac, getMacSet(macTag));
  }
}

async function destroyRules(macTag, dstTag, whitelist, destroyDstCache = true) {
  if (whitelist) {
    await setupWhitelistEnv(macTag, dstTag, null, true, destroyDstCache);
  } else {
    await setupBlockingEnv(macTag, dstTag, null, true, destroyDstCache);
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

async function unblock(destination, ipset) {
  ipset = ipset || "blocked_ip_set"

  // never unblock black hole ip
  if(f.isReservedBlockingIP(destination)) {
    return
  }

  let cmd = null;
  if(iptool.isV4Format(destination)) {
    cmd = `sudo ipset del -! ${ipset} ${destination}`
  } else if(iptool.isV6Format(destination)) {
    cmd = `sudo ipset del -! ${ipset}6 ${destination}`
  } else {
    // do nothing
    return
  }

  log.info("Control:UnBlock:",cmd);

  return exec(cmd)
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

  return exec(cmd);
}

function unblockPublicPort(localIPAddress, localPort, protocol, ipset) {
  ipset = ipset || "blocked_ip_port_set";
  log.info("Unblocking public port:", localIPAddress, localPort, protocol);
  protocol = protocol || "tcp";

  let entry = util.format("%s,%s:%s", localIPAddress, protocol, localPort);
  let cmd = null;

  if(iptool.isV4Format(localIPAddress)) {
    cmd = `sudo ipset del -! ${ipset} ${entry}`
  } else {
    cmd = `sudo ipset del -! ${ipset}6 ${entry}`
  }

  return exec(cmd);
}

module.exports = {
  setupBlockChain:setupBlockChain,
  blockMac: blockMac,
  unblockMac: unblockMac,
  block: block,
  unblock: unblock,
  setupCategoryEnv: setupCategoryEnv,
  setupRules: setupRules,
  destroyRules: destroyRules,
  addMacToSet: addMacToSet,
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
