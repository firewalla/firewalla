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

const SysManager = require("../net2/SysManager.js")
const sysManager = new SysManager()

const exec = require('child-process-promise').exec

const f = require('../net2/Firewalla.js')

const _wrapIptables = require('../net2/Iptables.js').wrapIptables;
const Ipset = require('../net2/Ipset.js');

const { Rule } = require('../net2/Iptables.js');

// =============== block @ connection level ==============

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

async function setupGlobalWhitelist(state) {
  try {
    let ruleSet = [
      new Rule().chn('FW_WHITELIST_PREROUTE').jmp('FW_WHITELIST'),
      new Rule('nat').chn('FW_NAT_WHITELIST_PREROUTE').jmp('FW_NAT_WHITELIST'),
    ]

    let ruleSet6 = ruleSet.map(r => r.clone().fam(6))

    for (const rule of ruleSet.concat(ruleSet6)) {
      const op = state ? '-A' : '-D';
      await exec(rule.toCmd(op));
    }
  } catch (err) {
    log.error("Failed to setup global whitelist", err);
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

function block(target, ipset, whitelist = false) {
  return setupIpset(target, ipset, whitelist)
}

function unblock(target, ipset, whitelist = false) {
  // never unblock black hole ip
  if (f.isReservedBlockingIP(target)) {
    return
  }

  return setupIpset(target, ipset, whitelist, true)
}

function setupIpset(target, ipset, whitelist, remove = false) {
  const ipSpliterIndex = target.search(/[/,]/)
  const ipAddr = ipSpliterIndex > 0 ? target.substring(0, ipSpliterIndex) : target;

  // check and add v6 suffix
  if (ipAddr.match(/^\d+(-\d+)?$/)) {
    // ports
  } else if (iptool.isV4Format(ipAddr)) {
    // ip.isV6Format() will return true on v4 addresses
    // ip.isV6Format() will return true for number
    // TODO: we should consider deprecate ip library
  } else if (iptool.isV6Format(ipAddr)) {
    ipset = ipset + '6';
  }
  const gateway6 = sysManager.myGateway6()
  const gateway = sysManager.myGateway()
  //Prevent gateway IP from being added into blocking IP set dynamically
  if (!remove && (gateway == ipAddr || gateway6 == ipAddr)) {
    return
  }
  const action = remove ? Ipset.del : Ipset.add;

  log.debug('setupIpset', action.prototype.constructor.name, ipset, target)

  return action(ipset, target)
}

async function setupRules(macTag, dstTag, dstType, allow = false, destroy = false, destroyDstCache = true) {
  if (!dstTag) {
    return;
  }

  try {
    log.info(destroy ? 'Destroying' : 'Creating', 'block environment for', macTag || "null", dstTag,
      destroy && destroyDstCache ? "and ipset" : "");

    const macSet = macTag ? getMacSet(macTag) : '';
    const dstSet = getDstSet(dstTag)
    // use same port set on both ip4 & ip6 rules
    const dstSet6 = dstType == 'bitmap:port' ? dstSet : getDstSet6(dstTag)

    if (!destroy) {
      if (macTag) await Ipset.create(macSet, 'hash:mac')
      await Ipset.create(dstSet, dstType)
      if (dstType != 'bitmap:port')
        await Ipset.create(dstSet6, dstType, false)
    }


    const filterChain = allow ? 'FW_WHITELIST' : 'FW_BLOCK'
    const filterDest = allow ? 'RETURN' : 'FW_DROP'
    const natChain = allow ? 'FW_NAT_WHITELIST' : 'FW_NAT_BLOCK'
    const natDest = allow ? 'RETURN' : 'FW_NAT_HOLE'

    const outRule     = new Rule().chn(filterChain).mth(dstSet, 'dst').jmp(filterDest)
    const outRule6    = new Rule().chn(filterChain).mth(dstSet6, 'dst').jmp(filterDest).fam(6)
    const natOutRule  = new Rule('nat').chn(natChain).mth(dstSet, 'dst').jmp(natDest)
    const natOutRule6 = new Rule('nat').chn(natChain).mth(dstSet6, 'dst').jmp(natDest).fam(6)

    // matching MAC addr won't work in opposite direction
    if (macTag) {
      outRule.mth(macSet, 'src')
      outRule6.mth(macSet, 'src')
      natOutRule.mth(macSet, 'src')
      natOutRule6.mth(macSet, 'src')
    }

    const op = destroy ? '-D' : '-I'
    await exec(outRule.toCmd(op))
    await exec(outRule6.toCmd(op))
    await exec(natOutRule.toCmd(op))
    await exec(natOutRule6.toCmd(op))


    if (destroy) {
      if (macTag) {
        await Ipset.destroy(macSet)
      }
      if (destroyDstCache) {
        await Ipset.destroy(dstSet)
        if (dstType != 'bitmap:port')
          await Ipset.destroy(dstSet6)
      }
    }

    log.info('Finish', destroy ? 'destroying' : 'creating', 'block environment for', macTag || "null", dstTag);

  } catch(err) {
    log.error('Error when setup blocking env', err);
  }
}

function destroyRules(macTag, dstTag, whitelist, destroyDstCache = true) {
  return setupRules(macTag, dstTag, null, whitelist, true, destroyDstCache)
}

async function addMacToSet(macAddresses, ipset = null, whitelist = false) {
  ipset = ipset || (whitelist ? 'blocked_mac_set' : 'whitelist_mac_set')

  for (const mac of macAddresses || []) {
    await Ipset.add(ipset, mac);
  }
}

async function delMacFromSet(macAddresses, ipset = null, whitelist = false) {
  ipset = ipset || (whitelist ? 'blocked_mac_set' : 'whitelist_mac_set')

  for (const mac of macAddresses || []) {
    await Ipset.del(ipset, mac);
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

  const entry = util.format("%s,%s:%s", localIPAddress, protocol, localPort);

  if(!iptool.isV4Format(localIPAddress)) {
    ipset = ipset + '6'
  }

  return Ipset.add(ipset, entry)
}

function unblockPublicPort(localIPAddress, localPort, protocol, ipset) {
  ipset = ipset || "blocked_ip_port_set";
  log.info("Unblocking public port:", localIPAddress, localPort, protocol);
  protocol = protocol || "tcp";

  let entry = util.format("%s,%s:%s", localIPAddress, protocol, localPort);

  if(!iptool.isV4Format(localIPAddress)) {
    ipset = ipset + '6'
  }

  return Ipset.del(ipset, entry)
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
  delMacFromSet: delMacFromSet,
  blockPublicPort:blockPublicPort,
  unblockPublicPort: unblockPublicPort,
  getDstSet: getDstSet,
  getDstSet6: getDstSet6,
  getMacSet: getMacSet,
  existsBlockingEnv: existsBlockingEnv,
  setupGlobalWhitelist: setupGlobalWhitelist
}
