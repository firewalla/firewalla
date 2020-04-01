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
const _ = require('lodash');
const log = require("../net2/logger.js")(__filename);

const iptool = require("ip");

const sysManager = require("../net2/SysManager.js")

const exec = require('child-process-promise').exec

const f = require('../net2/Firewalla.js')

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
    setupCategoryEnv("vpn"),
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

async function setupGlobalLockDown(state) {
  try {
    let ruleSet = [
      new Rule().chn('FW_LOCKDOWN_SELECTOR').jmp('FW_DROP'),
      new Rule('nat').chn('FW_NAT_LOCKDOWN_SELECTOR').jmp('FW_NAT_HOLE'),
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

async function setupInterfaceLockDown(state, uuid) {
  if (!uuid) {
    log.error("network uuid is not defined while setting up whitelist");
    return;
  }
  const networkIpsetName = require('../net2/NetworkProfile.js').getNetIpsetName(uuid);
  const networkIpsetName6 = require('../net2/NetworkProfile.js').getNetIpsetName(uuid, 6);
  if (!networkIpsetName || !networkIpsetName6) {
    log.error(`Failed to get ipset name for network ${uuid}`);
    return;
  }
  const ruleSet = [
    new Rule().chn('FW_LOCKDOWN_SELECTOR').mth(networkIpsetName, "src,src", "set").jmp('FW_DROP'),
    new Rule().chn('FW_LOCKDOWN_SELECTOR').mth(networkIpsetName, "dst,dst", "set").jmp('FW_DROP'),
    new Rule('nat').chn('FW_NAT_LOCKDOWN_SELECTOR').mth(networkIpsetName, "src,src", "set").jmp('FW_NAT_HOLE'),
    new Rule('nat').chn('FW_NAT_LOCKDOWN_SELECTOR').mth(networkIpsetName, "dst,dst", "set").jmp('FW_NAT_HOLE'),
    new Rule().chn('FW_LOCKDOWN_SELECTOR').mth(networkIpsetName6, "src,src", "set").jmp('FW_DROP').fam(6),
    new Rule().chn('FW_LOCKDOWN_SELECTOR').mth(networkIpsetName6, "dst,dst", "set").jmp('FW_DROP').fam(6),
    new Rule('nat').chn('FW_NAT_LOCKDOWN_SELECTOR').mth(networkIpsetName6, "src,src", "set").jmp('FW_NAT_HOLE').fam(6),
    new Rule('nat').chn('FW_NAT_LOCKDOWN_SELECTOR').mth(networkIpsetName6, "dst,dst", "set").jmp('FW_NAT_HOLE').fam(6)
  ];

  for (const rule of ruleSet) {
    const op = state ? '-A' : '-D';
    await exec(rule.toCmd(op)).catch((err) => {
      log.error(`Failed to execute rule ${rule.toCmd(op)}`, err);
    });
  }
}

async function setupTagLockDown(state, tagUid) {
  if (!tagUid) {
    log.error("tag uid is not defined while setting up whitelist");
    return;
  }
  const tagSet = require('../net2/Tag.js').getTagIpsetName(tagUid);
  const ruleSet = [
    new Rule().chn('FW_LOCKDOWN_SELECTOR').mth(tagSet, "src,src", "set").jmp('FW_DROP'),
    new Rule().chn('FW_LOCKDOWN_SELECTOR').mth(tagSet, "dst,dst", "set").jmp('FW_DROP'),
    new Rule('nat').chn('FW_NAT_LOCKDOWN_SELECTOR').mth(tagSet, "src,src", "set").jmp('FW_NAT_HOLE'),
    new Rule('nat').chn('FW_NAT_LOCKDOWN_SELECTOR').mth(tagSet, "dst,dst", "set").jmp('FW_NAT_HOLE')
  ];

  const ruleSet6 = ruleSet.map(r => r.clone().fam(6));

  for (const rule of ruleSet.concat(ruleSet6)) {
    const op = state ? '-A' : '-D';
    await exec(rule.toCmd(op)).catch((err) => {
      log.error(`Failed to execute rule ${rule.toCmd(op)}`, err);
    });
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

function block(target, ipset) {
  return setupIpset(target, ipset)
}

function unblock(target, ipset) {
  // never unblock black hole ip
  if (f.isReservedBlockingIP(target)) {
    return
  }

  return setupIpset(target, ipset, true)
}

function setupIpset(target, ipset, remove = false) {
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

async function setupRules(pid, macTag, dstTag, dstType, iif, allow = false, destroy = false, destroyDstCache = true) {
  try {
    log.info(destroy ? 'Destroying' : 'Creating', 'block environment for', macTag || "null", dstTag,
      destroy && destroyDstCache ? "and ipset" : "");

    const macSet = macTag ? getMacSet(macTag) : '';
    const dstSet = dstTag ? getDstSet(dstTag) : null;
    // use same port set on both ip4 & ip6 rules
    const dstSet6 = dstSet ? (dstType == 'bitmap:port' ? dstSet : getDstSet6(dstTag)) : null;

    if (!destroy) {
      if (macTag) await Ipset.create(macSet, 'hash:mac')
      if (dstTag) {
        await Ipset.create(dstSet, dstType)
        if (dstType != 'bitmap:port')
          await Ipset.create(dstSet6, dstType, false)
      }
    }

    const filterChain = allow ? 'FW_WHITELIST' : 'FW_BLOCK'
    const filterDest = allow ? 'FW_ACCEPT' : 'FW_DROP'
    const natChain = allow ? 'FW_NAT_WHITELIST' : 'FW_NAT_BLOCK'
    const natDest = allow ? 'ACCEPT' : 'FW_NAT_HOLE'

    const comment = `"Firewalla Policy ${pid}"`
    const outRule     = new Rule().chn(filterChain).jmp(filterDest).comment(comment)
    const outRule6    = new Rule().chn(filterChain).jmp(filterDest).fam(6).comment(comment)
    const natOutRule  = new Rule('nat').chn(natChain).jmp(natDest).comment(comment)
    const natOutRule6 = new Rule('nat').chn(natChain).jmp(natDest).fam(6).comment(comment)

    const spec = dstType != 'hash:ip,port' ? 'dst' : 'dst,dst';
    if (dstSet) {
      outRule.mth(dstSet, spec)
      outRule6.mth(dstSet6, spec)
      natOutRule.mth(dstSet, spec)
      natOutRule6.mth(dstSet6, spec)
    } else {
      // only match internet traffic
      outRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
      outRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
      natOutRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
      natOutRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
    }

    // matching MAC addr won't work in opposite direction
    if (macTag) {
      outRule.mth(macSet, 'src')
      outRule6.mth(macSet, 'src')
      natOutRule.mth(macSet, 'src')
      natOutRule6.mth(macSet, 'src')
    }

    if (iif) {
      outRule.mth(iif, null, "iif");
      outRule6.mth(iif, null, "iif");
      natOutRule.mth(iif, null, "iif");
      natOutRule6.mth(iif, null, "iif");
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
        if (dstSet) {
          await Ipset.destroy(dstSet)
          if (dstType != 'bitmap:port')
            await Ipset.destroy(dstSet6)
        }
      }
    }

    log.info('Finish', destroy ? 'destroying' : 'creating', 'block environment for', macTag || "null", dstTag);

  } catch(err) {
    log.error('Error when setup blocking env', err);
  }
}

async function setupTagRules(pid, tags, dstTag, dstType, allow = false, destroy = false, destroyDstCache = true) {
  if (_.isEmpty(tags)) {
    return;
  }

  const TagManager = require('../net2/TagManager.js')
  for (let index = 0; index < tags.length; index++) {
    if (!TagManager.getTagByUid(tags[index])) {
      continue;
    }

    try {
      log.info(destroy ? 'Destroying' : 'Creating', 'block environment for', pid || "null", dstTag,
        destroy && destroyDstCache ? "and ipset" : "");

      const dstSet = dstTag ? getDstSet(dstTag) : null;
      // use same port set on both ip4 & ip6 rules
      const dstSet6 = dstTag ? (dstType == 'bitmap:port' ? dstSet : getDstSet6(dstTag)) : null;

      if (!destroy) {
        if (dstSet) {
          await Ipset.create(dstSet, dstType);
          if (dstType != 'bitmap:port')
          await Ipset.create(dstSet6, dstType, false)
        }
      }

      const filterChain = allow ? 'FW_WHITELIST' : 'FW_BLOCK'
      const filterDest = allow ? 'FW_ACCEPT' : 'FW_DROP'
      const natChain = allow ? 'FW_NAT_WHITELIST' : 'FW_NAT_BLOCK'
      const natDest = allow ? 'ACCEPT' : 'FW_NAT_HOLE'

      const comment = `"Firewalla Policy ${pid}"`
      const outRule     = new Rule().chn(filterChain).jmp(filterDest).comment(comment)
      const outRule6    = new Rule().chn(filterChain).jmp(filterDest).fam(6).comment(comment)
      const natOutRule  = new Rule('nat').chn(natChain).jmp(natDest).comment(comment)
      const natOutRule6 = new Rule('nat').chn(natChain).jmp(natDest).fam(6).comment(comment)

      if (dstSet) {
        outRule.mth(dstSet, 'dst');
        outRule6.mth(dstSet6, 'dst');
        natOutRule.mth(dstSet, 'dst');
        natOutRule6.mth(dstSet6, 'dst');
      } else {
        // only match internet traffic
        outRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
        outRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
        natOutRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
        natOutRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
      }

      const inRule     = new Rule().chn(filterChain).jmp(filterDest).comment(comment)
      const inRule6    = new Rule().chn(filterChain).jmp(filterDest).fam(6).comment(comment)
      const natInRule  = new Rule('nat').chn(natChain).jmp(natDest).comment(comment)
      const natInRule6 = new Rule('nat').chn(natChain).jmp(natDest).fam(6).comment(comment)

      if (dstSet) {
        inRule.mth(dstSet, 'src');
        inRule6.mth(dstSet6, 'src');
        natInRule.mth(dstSet, 'src');
        natInRule6.mth(dstSet6, 'src');
      } else {
        // only match internet traffic
        inRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false);
        inRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false);
        natInRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false);
        natInRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false);
      }

      const ipset = require('../net2/Tag.js').getTagIpsetName(tags[index]);
      outRule.mth(ipset, 'src,src')
      outRule6.mth(ipset, 'src,src')
      natOutRule.mth(ipset, 'src,src')
      natOutRule6.mth(ipset, 'src,src')

      inRule.mth(ipset, 'dst,dst')
      inRule6.mth(ipset, 'dst,dst')
      natInRule.mth(ipset, 'dst,dst')
      natInRule6.mth(ipset, 'dst,dst')

      const op = destroy ? '-D' : '-I'
      await exec(outRule.toCmd(op))
      await exec(outRule6.toCmd(op))
      await exec(natOutRule.toCmd(op))
      await exec(natOutRule6.toCmd(op))
      await exec(inRule.toCmd(op))
      await exec(inRule6.toCmd(op))
      await exec(natInRule.toCmd(op))
      await exec(natInRule6.toCmd(op))

      if (destroy) {
        if (destroyDstCache) {
          if (dstSet) {
            await Ipset.destroy(dstSet)
            if (dstType != 'bitmap:port')
              await Ipset.destroy(dstSet6)
          }
        }
      }

      log.info('Finish', destroy ? 'destroying' : 'creating', 'block environment for', pid || "null", dstTag);

    } catch(err) {
      log.error('Error when setup tag blocking env', err);
    }
  }
}

async function setupIntfsRules(pid, intfs, dstTag, dstType, allow = false, destroy = false, destroyDstCache = true) {
  if (_.isEmpty(intfs)) {
    return;
  }

  const NetworkProfile = require('../net2/NetworkProfile.js');
  for (let index = 0; index < intfs.length; index++) {
    await NetworkProfile.ensureCreateEnforcementEnv(intfs[index]);

    try {
      log.info(destroy ? 'Destroying' : 'Creating', 'block environment for', pid || "null", dstTag,
        destroy && destroyDstCache ? "and ipset" : "");

      const dstSet = dstTag ? getDstSet(dstTag) : null;
      // use same port set on both ip4 & ip6 rules
      const dstSet6 = dstTag ? (dstType == 'bitmap:port' ? dstSet : getDstSet6(dstTag)) : null;

      if (!destroy) {
        if (dstSet) {
          await Ipset.create(dstSet, dstType);
          if (dstType != 'bitmap:port')
          await Ipset.create(dstSet6, dstType, false)
        }
      }

      const filterChain = allow ? 'FW_WHITELIST' : 'FW_BLOCK'
      const filterDest = allow ? 'FW_ACCEPT' : 'FW_DROP'
      const natChain = allow ? 'FW_NAT_WHITELIST' : 'FW_NAT_BLOCK'
      const natDest = allow ? 'ACCEPT' : 'FW_NAT_HOLE'

      const comment = `"Firewalla Policy ${pid}"`
      const outRule     = new Rule().chn(filterChain).jmp(filterDest).comment(comment)
      const outRule6    = new Rule().chn(filterChain).jmp(filterDest).fam(6).comment(comment)
      const natOutRule  = new Rule('nat').chn(natChain).jmp(natDest).comment(comment)
      const natOutRule6 = new Rule('nat').chn(natChain).jmp(natDest).fam(6).comment(comment)

      if (dstSet) {
        outRule.mth(dstSet, 'dst');
        outRule6.mth(dstSet6, 'dst');
        natOutRule.mth(dstSet, 'dst');
        natOutRule6.mth(dstSet6, 'dst');
      } else {
        // only match internet traffic
        outRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
        outRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
        natOutRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
        natOutRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "dst,dst", "set", false);
      }

      const inRule     = new Rule().chn(filterChain).jmp(filterDest).comment(comment)
      const inRule6    = new Rule().chn(filterChain).jmp(filterDest).fam(6).comment(comment)
      const natInRule  = new Rule('nat').chn(natChain).jmp(natDest).comment(comment)
      const natInRule6 = new Rule('nat').chn(natChain).jmp(natDest).fam(6).comment(comment)

      if (dstSet) {
        inRule.mth(dstSet, 'src');
        inRule6.mth(dstSet6, 'src');
        natInRule.mth(dstSet, 'src');
        natInRule6.mth(dstSet6, 'src');
      } else {
        // only match internet traffic
        inRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false);
        inRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false);
        natInRule.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false);
        natInRule6.mth(Ipset.CONSTANTS.IPSET_MONITORED_NET, "src,src", "set", false);
      }

      const ipset = require('../net2/NetworkProfile.js').getNetIpsetName(intfs[index]);
      const ipset6 = require('../net2/NetworkProfile.js').getNetIpsetName(intfs[index], 6);
      outRule.mth(ipset, 'src,src')
      outRule6.mth(ipset6, 'src,src')
      natOutRule.mth(ipset, 'src,src')
      natOutRule6.mth(ipset6, 'src,src')

      inRule.mth(ipset, 'dst,dst')
      inRule6.mth(ipset6, 'dst,dst')
      natInRule.mth(ipset, 'dst,dst')
      natInRule6.mth(ipset6, 'dst,dst')

      const op = destroy ? '-D' : '-I'
      await exec(outRule.toCmd(op))
      await exec(outRule6.toCmd(op))
      await exec(natOutRule.toCmd(op))
      await exec(natOutRule6.toCmd(op))
      await exec(inRule.toCmd(op))
      await exec(inRule6.toCmd(op))
      await exec(natInRule.toCmd(op))
      await exec(natInRule6.toCmd(op))

      if (destroy) {
        if (destroyDstCache) {
          if (dstSet) {
            await Ipset.destroy(dstSet)
            if (dstType != 'bitmap:port')
              await Ipset.destroy(dstSet6)
          }
        }
      }

      log.info('Finish', destroy ? 'destroying' : 'creating', 'block environment for', pid || "null", dstTag);

    } catch(err) {
      log.error('Error when setup intf blocking env', err);
    }
  }
}

async function addMacToSet(macAddresses, ipset = null, whitelist = false) {
  ipset = ipset || (whitelist ? 'whitelist_mac_set' : 'blocked_mac_set');

  for (const mac of macAddresses || []) {
    await Ipset.add(ipset, mac);
  }
}

async function delMacFromSet(macAddresses, ipset = null, whitelist = false) {
  ipset = ipset || (whitelist ? 'whitelist_mac_set' : 'blocked_mac_set');

  for (const mac of macAddresses || []) {
    await Ipset.del(ipset, mac);
  }
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

async function createMatchingSet(id, type, af = 4) {
  if (!id || !type)
    return null;
  let name = `c_${id}`;
  await Ipset.create(name, type, af == 4).catch((err) => {
    log.error(`Failed to create ipset ${name}`, err.message);
    name = null;
  });
  return name;
}

async function addToMatchingSet(id, value) {
  if (!id || !value)
    return;
  const name = `c_${id}`;
  await Ipset.add(name, value).catch((err) => {
    log.error(`Failed to add ${value} to ipset ${name}`, err.message);
  });
}

async function destroyMatchingSet(id) {
  if (!id)
    return;
  const name = `c_${id}`;
  await Ipset.destroy(name).catch((err) => {
    log.error(`Failed to destroy ipset ${name}`, err.message);
  });
}

async function manipulateFiveTupleRule(action, srcMatchingSet, srcSpec, sport, dstMatchingSet, dstSpec, dport, proto, target, chain, table, af = 4) {
  // sport and dport can be range string, e.g., 10000-20000
  const rule = new Rule(table).fam(af).chn(chain);
  if (srcMatchingSet)
    rule.mth(srcMatchingSet, srcSpec, "set");
  if (sport)
    rule.mth(sport, null, "sport");
  if (dstMatchingSet)
    rule.mth(dstMatchingSet, dstSpec, "set");
  if (dport)
    rule.mth(dport, null, "dport");
  if (proto)
    rule.pro(proto);
  rule.jmp(target);
  await exec(rule.toCmd(action));
}


module.exports = {
  setupBlockChain:setupBlockChain,
  block: block,
  unblock: unblock,
  setupCategoryEnv: setupCategoryEnv,
  setupRules: setupRules,
  addMacToSet: addMacToSet,
  delMacFromSet: delMacFromSet,
  blockPublicPort:blockPublicPort,
  unblockPublicPort: unblockPublicPort,
  getDstSet: getDstSet,
  getDstSet6: getDstSet6,
  getMacSet: getMacSet,
  existsBlockingEnv: existsBlockingEnv,
  setupGlobalLockDown: setupGlobalLockDown,
  setupNetworkLockDown: setupInterfaceLockDown,
  setupTagLockDown: setupTagLockDown,
  setupTagRules: setupTagRules,
  setupIntfsRules: setupIntfsRules,
  createMatchingSet: createMatchingSet,
  addToMatchingSet: addToMatchingSet,
  destroyMatchingSet: destroyMatchingSet,
  manipulateFiveTupleRule: manipulateFiveTupleRule
}
