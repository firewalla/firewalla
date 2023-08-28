/*    Copyright 2016-2023 Firewalla Inc.
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

const _ = require('lodash');
const log = require("../net2/logger.js")(__filename);

const { Address4, Address6 } = require('ip-address')

const sysManager = require("../net2/SysManager.js")

const exec = require('child-process-promise').exec

const f = require('../net2/Firewalla.js')

const Ipset = require('../net2/Ipset.js');
const Constants = require('../net2/Constants.js');

const { Rule } = require('../net2/Iptables.js');
const qos = require('./QoS.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();

const VPNClient = require('../extension/vpnclient/VPNClient.js');
const { CategoryEntry } = require('./CategoryEntry.js');
const VPN_CLIENT_WAN_PREFIX = Constants.ACL_VPN_CLIENT_WAN_PREFIX;
const VIRT_WAN_GROUP_PREFIX = Constants.ACL_VIRT_WAN_GROUP_PREFIX;
const UPNP_ACCEPT_CHAIN = "FR_UPNP_ACCEPT";

const initializedRuleGroups = {};
const routeLogRateLimitPerSecond = 10;

// =============== block @ connection level ==============

async function ensureCreateRuleGroupChain(uuid) {
  if (initializedRuleGroups[uuid] === 1)
    return;
  const cmds = [
    `sudo iptables -w -t filter -N ${getRuleGroupChainName(uuid, "allow")} &> /dev/null`,
    `sudo iptables -w -t filter -N ${getRuleGroupChainName(uuid, "block")} &> /dev/null`,
    `sudo ip6tables -w -t filter -N ${getRuleGroupChainName(uuid, "allow")} &> /dev/null`,
    `sudo ip6tables -w -t filter -N ${getRuleGroupChainName(uuid, "block")} &> /dev/null`,
    `sudo iptables -w -t filter -N ${getRuleGroupChainName(uuid, "allow")}_HI &> /dev/null`,
    `sudo iptables -w -t filter -N ${getRuleGroupChainName(uuid, "block")}_HI &> /dev/null`,
    `sudo ip6tables -w -t filter -N ${getRuleGroupChainName(uuid, "allow")}_HI &> /dev/null`,
    `sudo ip6tables -w -t filter -N ${getRuleGroupChainName(uuid, "block")}_HI &> /dev/null`,
    `sudo iptables -w -t filter -N ${getRuleGroupChainName(uuid, "allow")}_LO &> /dev/null`,
    `sudo iptables -w -t filter -N ${getRuleGroupChainName(uuid, "block")}_LO &> /dev/null`,
    `sudo ip6tables -w -t filter -N ${getRuleGroupChainName(uuid, "allow")}_LO &> /dev/null`,
    `sudo ip6tables -w -t filter -N ${getRuleGroupChainName(uuid, "block")}_LO &> /dev/null`,
    `sudo iptables -w -t filter -N ${getRuleGroupChainName(uuid, "alarm")} &> /dev/null`,
    `sudo ip6tables -w -t filter -N ${getRuleGroupChainName(uuid, "alarm")} &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_1 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_1 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_2 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_2 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_3 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_3 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_4 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_4 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_5 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")}_5 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_1 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_1 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_2 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_2 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_3 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_3 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_4 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_4 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_5 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")}_5 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_1 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_1 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_2 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_2 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_3 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_3 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_4 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_4 &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_5 &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "soft_route")}_5 &> /dev/null`,
    `sudo iptables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_1 &> /dev/null`,
    `sudo ip6tables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_1 &> /dev/null`,
    `sudo iptables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_2 &> /dev/null`,
    `sudo ip6tables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_2 &> /dev/null`,
    `sudo iptables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_3 &> /dev/null`,
    `sudo ip6tables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_3 &> /dev/null`,
    `sudo iptables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_4 &> /dev/null`,
    `sudo ip6tables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_4 &> /dev/null`,
    `sudo iptables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_5 &> /dev/null`,
    `sudo ip6tables -w -t nat -N ${getRuleGroupChainName(uuid, "snat")}_5 &> /dev/null`,
  ];
  let initialized = true;
  for (const cmd of cmds) {
    await exec(cmd).catch((err) => {
      log.error(`Failed to create rule group chain for ${uuid}`, cmd, err.message);
      initialized = false;
    });
  }
  if (initialized)
    initializedRuleGroups[uuid] = 1;
}

function getRuleGroupChainName(uuid, action) {
  switch (action) {
    case "qos":
      return `FW_RG_${uuid.substring(0, 13)}_QOS`;
    case "soft_route":
      return `FW_RG_${uuid.substring(0, 13)}_SROUTE`;
    case "route":
      return `FW_RG_${uuid.substring(0, 13)}_ROUTE`;
    case "allow":
      return `FW_RG_${uuid.substring(0, 13)}_ALLOW`;
    case "alarm":
      return `FW_RG_${uuid.substring(0, 13)}_ALARM`;
    case "snat":
      return `FW_RG_${uuid.substring(0, 13)}_SNAT`;
    case "block":
    default:
      return `FW_RG_${uuid.substring(0, 13)}_BLOCK`;
  }
}

// This function MUST be called at the beginning of main.js
async function setupBlockChain() {
  log.info("Setting up iptables for traffic blocking");
  let cmd = __dirname + "/install_iptables_setup.sh";

  await exec(cmd);


  await Promise.all([
    /*
    setupCategoryEnv("games"),
    setupCategoryEnv("porn"),
    setupCategoryEnv("social"),
    setupCategoryEnv("vpn"),
    setupCategoryEnv("shopping"),
    setupCategoryEnv("p2p"),
    setupCategoryEnv("gamble"),
    setupCategoryEnv("av"),
    */
    setupCategoryEnv("default_c", "hash:net", 4096),
  ])

  log.info("Finished setup for traffic blocking");
}

function getMacSet(tag) {
  return `c_bm_${tag}_set`
}

function getDstSet(tag) {
  return `c_bd_${tag}_set`
}

function getTLSHostSet(tag) {
  return `c_bd_${tag}_tls_hostset`
}

function getDstSet6(tag) {
  return `c_bd_${tag}_set6`
}

function getDropChain(security, tls) {
  return `FW_${security ? "SEC_" : ""}${tls ? "TLS_" : ""}DROP`;
}

async function setupCategoryEnv(category, dstType = "hash:ip", hashSize = 128, needComment = false, isCountry = false) {
  let commentIndicator = "";
  if (needComment) {
    commentIndicator = "comment";
  }

  if (!category) {
    return;
  }

  const CategoryUpdater = require('./CategoryUpdater.js');
  const categoryUpdater = new CategoryUpdater();

  const ipset = categoryUpdater.getIPSetName(category);
  const tempIpset = categoryUpdater.getTempIPSetName(category);
  const ipset6 = categoryUpdater.getIPSetNameForIPV6(category);
  const tempIpset6 = categoryUpdater.getTempIPSetNameForIPV6(category);

  const cmdCreateCategorySet = `sudo ipset create -! ${ipset} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`}`
  const cmdCreateCategorySet6 = `sudo ipset create -! ${ipset6} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`}`
  const cmdCreateTempCategorySet = `sudo ipset create -! ${tempIpset} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`}`
  const cmdCreateTempCategorySet6 = `sudo ipset create -! ${tempIpset6} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`}`

  await exec(cmdCreateCategorySet);
  await exec(cmdCreateCategorySet6);
  await exec(cmdCreateTempCategorySet);
  await exec(cmdCreateTempCategorySet6);

  if (!isCountry) { // country does not need following ipsets
    const staticIpset = categoryUpdater.getIPSetName(category, true);
    const tempStaticIpset = categoryUpdater.getTempIPSetName(category, true);
    const staticIpset6 = categoryUpdater.getIPSetNameForIPV6(category, true);
    const tempStaticIpset6 = categoryUpdater.getTempIPSetNameForIPV6(category, true);
  
    const netPortIpset = categoryUpdater.getNetPortIPSetName(category);
    const tempNetPortIpset = categoryUpdater.getTempNetPortIPSetName(category);
    const netPortIpset6 = categoryUpdater.getNetPortIPSetNameForIPV6(category);
    const tempNetPortIpset6 = categoryUpdater.getTempNetPortIPSetNameForIPV6(category);
  
    const domainPortIpset = categoryUpdater.getDomainPortIPSetName(category);
    const tempDomainPortIpset = categoryUpdater.getTempDomainPortIPSetName(category);
    const domainPortIpset6 = categoryUpdater.getDomainPortIPSetNameForIPV6(category);
    const tempDomainPortIpset6 = categoryUpdater.getTempDomainPortIPSetNameForIPV6(category);
  
    const staticDomainPortIpset = categoryUpdater.getDomainPortIPSetName(category, true);
    const tempStaticDomainPortIpset = categoryUpdater.getTempDomainPortIPSetName(category, true);
    const staticDomainPortIpset6 = categoryUpdater.getDomainPortIPSetNameForIPV6(category, true);
    const tempStaticDomainPortIpset6 = categoryUpdater.getTempDomainPortIPSetNameForIPV6(category, true);
  
    const aggrIpset = categoryUpdater.getAggrIPSetName(category);
    const aggrIpset6 = categoryUpdater.getAggrIPSetNameForIPV6(category);
    const staticAggrIpset = categoryUpdater.getAggrIPSetName(category, true);
    const staticAggrIpset6 = categoryUpdater.getAggrIPSetNameForIPV6(category, true);
    const allowIpset = categoryUpdater.getAllowIPSetName(category);
    const allowIpset6 = categoryUpdater.getAllowIPSetNameForIPV6(category);

    const cmdCreateNetPortCategorySet = `sudo ipset create -! ${netPortIpset} hash:net,port family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
    const cmdCreateNetPortCategorySet6 = `sudo ipset create -! ${netPortIpset6} hash:net,port family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
    const cmdCreateTempNetPortCategorySet = `sudo ipset create -! ${tempNetPortIpset} hash:net,port family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
    const cmdCreateTempNetPortCategorySet6 = `sudo ipset create -! ${tempNetPortIpset6} hash:net,port family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
    const cmdCreateDomainPortCategorySet = `sudo ipset create -! ${domainPortIpset} hash:net,port family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
    const cmdCreateDomainPortCategorySet6 = `sudo ipset create -! ${domainPortIpset6}  hash:net,port family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
    const cmdCreateTempDomainPortCategorySet = `sudo ipset create -! ${tempDomainPortIpset} hash:net,port family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`;
    const cmdCreateTempDomainPortCategorySet6 = `sudo ipset create -! ${tempDomainPortIpset6}  hash:net,port family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`;
    const cmdCreateAggrCategorySet = `sudo ipset create -! ${aggrIpset} list:set`;
    const cmdCreateAggrCategorySet6 = `sudo ipset create -! ${aggrIpset6} list:set`;
  
  
    const cmdCreateStaticCategorySet = `sudo ipset create -! ${staticIpset} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`}`
    const cmdCreateStaticCategorySet6 = `sudo ipset create -! ${staticIpset6} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`}`
    const cmdCreateTempStaticCategorySet = `sudo ipset create -! ${tempStaticIpset} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`}`
    const cmdCreateTempStaticCategorySet6 = `sudo ipset create -! ${tempStaticIpset6} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`}`
    const cmdCreateStaticDomainPortCategorySet = `sudo ipset create -! ${staticDomainPortIpset} hash:net,port family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
    const cmdCreateStaticDomainPortCategorySet6 = `sudo ipset create -! ${staticDomainPortIpset6} hash:net,port family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
    const cmdCreateTempStaticDomainPortCategorySet = `sudo ipset create -! ${tempStaticDomainPortIpset} hash:net,port family inet hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
    const cmdCreateTempStaticDomainPortCategorySet6 = `sudo ipset create -! ${tempStaticDomainPortIpset6} hash:net,port family inet6 hashsize ${hashSize} maxelem 65536 ${commentIndicator}`
  
    const cmdCreateStaticAggrCategorySet = `sudo ipset create -! ${staticAggrIpset} list:set`
    const cmdCreateStaticAggrCategorySet6 = `sudo ipset create -! ${staticAggrIpset6} list:set`
  
    const cmdCreateAllowCategorySet = `sudo ipset create -! ${allowIpset} list:set`
    const cmdCreateAllowCategorySet6 = `sudo ipset create -! ${allowIpset6} list:set`
  
    const cmdAddNet = `sudo ipset add -! ${aggrIpset} ${ipset}; sudo ipset add -! ${aggrIpset} ${staticIpset}`; // add both dynamic and static ipset to category default ipset
    const cmdAddNetPort = `sudo ipset add -! ${aggrIpset} ${netPortIpset}`;
    const cmdAddDomainPort = `sudo ipset add -! ${aggrIpset} ${staticDomainPortIpset}`;
    const cmdAddNet6 = `sudo ipset add -! ${aggrIpset6} ${ipset6}; sudo ipset add -! ${aggrIpset6} ${staticIpset6}`;
    const cmdAddNetPort6 = `sudo ipset add -! ${aggrIpset6} ${netPortIpset6}`;
    const cmdAddDomainPort6 = `sudo ipset add -! ${aggrIpset6} ${staticDomainPortIpset6}`;
  
    const cmdAddStaticNet = `sudo ipset add -! ${staticAggrIpset} ${staticIpset}`; // only add static ipset to category static ipset
    const cmdAddStaticNetPort = `sudo ipset add -! ${staticAggrIpset} ${netPortIpset}`;
    const cmdAddStaticDomainPort = `sudo ipset add -! ${staticAggrIpset} ${staticDomainPortIpset}`;
    const cmdAddStaticNet6 = `sudo ipset add -! ${staticAggrIpset6} ${staticIpset6}`;
    const cmdAddStaticNetPort6 = `sudo ipset add -! ${staticAggrIpset6} ${netPortIpset6}`;
    const cmdAddStaticDomainPort6 = `sudo ipset add -! ${staticAggrIpset6} ${staticDomainPortIpset6}`;
  
    const cmdAddAllowNet = `sudo ipset add -! ${allowIpset} ${ipset}; sudo ipset add -! ${allowIpset} ${staticIpset}`;
    const cmdAddAllowNet6 = `sudo ipset add -! ${allowIpset6} ${ipset6}; sudo ipset add -! ${allowIpset6} ${staticIpset6}`;
    const cmdAddAllowNetPort = `sudo ipset add -! ${allowIpset} ${netPortIpset}`;
    const cmdAddAllowNetPort6 = `sudo ipset add -! ${allowIpset6} ${netPortIpset6}`;
    const cmdAddAllowDomainport = `sudo ipset add -! ${allowIpset} ${domainPortIpset}; sudo ipset add -! ${allowIpset} ${staticDomainPortIpset}`;
    const cmdAddAllowDomainport6 = `sudo ipset add -! ${allowIpset6} ${domainPortIpset6}; sudo ipset add -! ${allowIpset6} ${staticDomainPortIpset6}`;

    await exec(cmdCreateNetPortCategorySet);
    await exec(cmdCreateNetPortCategorySet6);
    await exec(cmdCreateTempNetPortCategorySet);
    await exec(cmdCreateTempNetPortCategorySet6);
    await exec(cmdCreateDomainPortCategorySet);
    await exec(cmdCreateDomainPortCategorySet6);
    await exec(cmdCreateTempDomainPortCategorySet);
    await exec(cmdCreateTempDomainPortCategorySet6);
    await exec(cmdCreateStaticDomainPortCategorySet);
    await exec(cmdCreateStaticDomainPortCategorySet6);
    await exec(cmdCreateTempStaticDomainPortCategorySet);
    await exec(cmdCreateTempStaticDomainPortCategorySet6);
  
    await exec(cmdCreateAggrCategorySet);
    await exec(cmdCreateAggrCategorySet6); 
  
    await exec(cmdCreateStaticCategorySet);
    await exec(cmdCreateStaticCategorySet6);
    await exec(cmdCreateTempStaticCategorySet);
    await exec(cmdCreateTempStaticCategorySet6);
  
    await exec(cmdCreateStaticAggrCategorySet);
    await exec(cmdCreateStaticAggrCategorySet6);
  
    await exec(cmdCreateAllowCategorySet);
    await exec(cmdCreateAllowCategorySet6);
  
    await exec(cmdAddNet);
    await exec(cmdAddNetPort);
    await exec(cmdAddDomainPort);
    await exec(cmdAddNet6);
    await exec(cmdAddNetPort6);
    await exec(cmdAddDomainPort6);
    await exec(cmdAddStaticNet);
    await exec(cmdAddStaticNetPort);
    await exec(cmdAddStaticDomainPort);
    await exec(cmdAddStaticNet6);
    await exec(cmdAddStaticNetPort6);
    await exec(cmdAddStaticDomainPort6);
    await exec(cmdAddAllowNet);
    await exec(cmdAddAllowNet6);
    await exec(cmdAddAllowNetPort);
    await exec(cmdAddAllowNetPort6);
    await exec(cmdAddAllowDomainport);
    await exec(cmdAddAllowDomainport6);
  }
}

async function existsBlockingEnv(tag) {
  const cmd = `sudo iptables -w -L FW_BLOCK | grep ${getMacSet(tag)} | wc -l`
  try {
    let output = await exec(cmd);
    if (output.stdout == 4) {
      return true
    } else {
      return false
    }
  } catch (err) {
    log.error('Error when check blocking env existence', err);
  }
}

function batchBlock(elements, ipset, options) {
  return batchSetupIpset(elements, ipset, false, options);
}

function batchUnblock(elements, ipset) {
  return batchSetupIpset(elements, ipset, true);
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

// this is used only for user defined target list so there is no need to remove from ipset. The ipset will be reset upon category reload or update.
function batchBlockNetPort(elements, portObj, ipset, options = {}) {
  log.debug("Batch block net port of", ipset);
  if (!_.isArray(elements) || elements.length === 0)
    return;
  const v4Set = ipset;
  const v6Set = ipset + '6';
  const gateway6 = sysManager.myGateway6();
  const gateway = sysManager.myDefaultGateway();
  const cmds = [];
  const op = 'add';

  for (const element of elements) {
    const ipSpliterIndex = element.search(/[/,]/)
    const ipAddr = ipSpliterIndex > 0 ? element.substring(0, ipSpliterIndex) : element;

    //Prevent gateway IP from being added into blocking IP set dynamically
    if (gateway == ipAddr || gateway6 == ipAddr) {
      continue;
    }
    if (new Address4(ipAddr).isValid()) {
      if (options.comment) {
        cmds.push(`${op} ${v4Set} ${ipAddr},${CategoryEntry.toPortStr(portObj)} comment ${options.comment}`);
      } else {
        cmds.push(`${op} ${v4Set} ${ipAddr},${CategoryEntry.toPortStr(portObj)}`);
      }
    } else {
      const ip6 = new Address6(ipAddr);
      if (ip6.isValid() && ip6.correctForm() != '::') {
        if (options.comment) {
          cmds.push(`${op} ${v6Set} ${ipAddr},${CategoryEntry.toPortStr(portObj)} comment ${options.comment}`);
        } else {
          cmds.push(`${op} ${v6Set} ${ipAddr},${CategoryEntry.toPortStr(portObj)}`);
        }
      }
    }
  }
  log.debug(`Batch setup IP set ${op}`, cmds);
  return Ipset.batchOp(cmds);
}

async function batchSetupIpset(elements, ipset, remove = false, options = {}) {
  if (!_.isArray(elements) || elements.length === 0)
    return;
  const v4Set = ipset;
  const v6Set = ipset + '6';
  const gateway6 = sysManager.myGateway6();
  const gateway = sysManager.myDefaultGateway();
  const cmds = [];
  const op = remove ? 'del' : 'add';

  for (const element of elements) {
    const ipSpliterIndex = element.search(/[/,]/)
    const ipAddr = ipSpliterIndex > 0 ? element.substring(0, ipSpliterIndex) : element;

    //Prevent gateway IP from being added into blocking IP set dynamically
    if (!remove && (gateway == ipAddr || gateway6 == ipAddr)) {
      continue;
    }
    // check and add v6 suffix
    if (ipAddr.match(/^\d+(-\d+)?$/)) {
      // ports
      cmds.push(`${op} ${v4Set} ${ipAddr}`);
    } else if (new Address4(ipAddr).isValid()) {
      if (options.comment) {
        cmds.push(`${op} ${v4Set} ${ipAddr} comment ${options.comment}`);
      } else {
        cmds.push(`${op} ${v4Set} ${ipAddr}`);
      }
    } else {
      const ip6 = new Address6(ipAddr);
      if (ip6.isValid() && ip6.correctForm() != '::') {
        if (options.comment) {
          cmds.push(`${op} ${v6Set} ${ipAddr} comment ${options.comment}`);
        } else {
          cmds.push(`${op} ${v6Set} ${ipAddr}`);
        }
      }
    }
  }
  return Ipset.batchOp(cmds);
}

function setupIpset(element, ipset, remove = false) {
  const ipSpliterIndex = element.search(/[/,]/)
  const ipAddr = ipSpliterIndex > 0 ? element.substring(0, ipSpliterIndex) : element;

  // check and add v6 suffix
  if (ipAddr.match(/^\d+(-\d+)?$/)) {
    // ports
  } else if (new Address4(ipAddr).isValid()) {
    // nothing needs to be done for v4 addresses
  } else {
    const ip6 = new Address6(ipAddr);
    if (ip6.correctForm() == '::') return

    if (ip6.isValid() && ip6.correctForm() != '::') {
      ipset = ipset + '6';
    } else {
      return
    }
  }
  const gateway6 = sysManager.myGateway6()
  const gateway = sysManager.myDefaultGateway()
  //Prevent gateway IP from being added into blocking IP set dynamically
  if (!remove && (gateway == ipAddr || gateway6 == ipAddr)) {
    return
  }
  const action = remove ? Ipset.del : Ipset.add;

  log.debug('setupIpset', action.prototype.constructor.name, ipset, element)

  return action(ipset, element)
}

async function setupGlobalRules(pid, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass) {
  log.verbose(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const parameters = [];
  const filterPrio = 1;
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
      break;
    case Constants.RULE_SEQ_LO:
      chainSuffix = "_LO";
      break;
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      priority = priority || qos.DEFAULT_PRIO;
      qdisc = qdisc || "fq_codel";
      if (ratelimit) {
        let parentHTBQdisc = "3";
        let subclassId = "4";
        if (priority <= qos.PRIO_HIGH) {
          parentHTBQdisc = "2";
          subclassId = "1";
        } else {
          if (priority > qos.PRIO_REG) {
            parentHTBQdisc = "4";
            subclassId = "7";
          }
        }
        if (createOrDestroy === "create") {
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit, priority, qdisc, flowIsolation);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit);
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
        }
      } else {
        let subclassId = qdisc == "fq_codel" ? "5" : "6";
        if (priority <= qos.PRIO_HIGH) {
          subclassId = qdisc == "fq_codel" ? "2" : "3";
        } else {
          if (priority > qos.PRIO_REG) {
            subclassId = qdisc == "fq_codel" ? "8" : "9";
          }
        }
        if (createOrDestroy === "create")
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
      }
      parameters.push({ table: "mangle", chain: `FW_QOS_GLOBAL_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}` });
      break;
    }
    case "route": {
      // policy-based routing can only apply to outbound connection
      direction = "outbound";
      let hardRoute = true;
      if (routeType === "soft")
        hardRoute = false;
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        await VPNClient.ensureCreateEnforcementEnv(profileId);
        // tentatively disable route rule iptables log as it is not used now
        // parameters.push({ table: "mangle", chain: `FW_RT_GLOBAL_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_GLOBAL_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          // parameters.push({ table: "mangle", chain: `FW_RT_GLOBAL_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_GLOBAL_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          // parameters.push({ table: "mangle", chain: `FW_RT_GLOBAL_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_GLOBAL_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
        }
      }
      break;
    }
    case "match_group": {
      await ensureCreateRuleGroupChain(targetRgId);
      parameters.push({ table: "filter", chain: "FW_FIREWALL_GLOBAL_ALLOW", target: getRuleGroupChainName(targetRgId, "allow") });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_GLOBAL_BLOCK", target: getRuleGroupChainName(targetRgId, "block") });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_GLOBAL_ALLOW_HI", target: getRuleGroupChainName(targetRgId, "allow") + "_HI" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_GLOBAL_BLOCK_HI", target: getRuleGroupChainName(targetRgId, "block") + "_HI" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_GLOBAL_ALLOW_LO", target: getRuleGroupChainName(targetRgId, "allow") + "_LO" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_GLOBAL_BLOCK_LO", target: getRuleGroupChainName(targetRgId, "block") + "_LO" });
      parameters.push({ table: "mangle", chain: "FW_QOS_GLOBAL_1", target: `${getRuleGroupChainName(targetRgId, "qos")}_1` });
      parameters.push({ table: "mangle", chain: "FW_QOS_GLOBAL_2", target: `${getRuleGroupChainName(targetRgId, "qos")}_2` });
      parameters.push({ table: "mangle", chain: "FW_QOS_GLOBAL_3", target: `${getRuleGroupChainName(targetRgId, "qos")}_3` });
      parameters.push({ table: "mangle", chain: "FW_QOS_GLOBAL_4", target: `${getRuleGroupChainName(targetRgId, "qos")}_4` });
      parameters.push({ table: "mangle", chain: "FW_QOS_GLOBAL_5", target: `${getRuleGroupChainName(targetRgId, "qos")}_5` });
      parameters.push({ table: "mangle", chain: "FW_RT_GLOBAL_1", target: `${getRuleGroupChainName(targetRgId, "route")}_1` });
      parameters.push({ table: "mangle", chain: "FW_RT_GLOBAL_2", target: `${getRuleGroupChainName(targetRgId, "route")}_2` });
      parameters.push({ table: "mangle", chain: "FW_RT_GLOBAL_3", target: `${getRuleGroupChainName(targetRgId, "route")}_3` });
      parameters.push({ table: "mangle", chain: "FW_RT_GLOBAL_4", target: `${getRuleGroupChainName(targetRgId, "route")}_4` });
      parameters.push({ table: "mangle", chain: "FW_RT_GLOBAL_5", target: `${getRuleGroupChainName(targetRgId, "route")}_5` });
      parameters.push({ table: "mangle", chain: "FW_SRT_GLOBAL_1", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_1` });
      parameters.push({ table: "mangle", chain: "FW_SRT_GLOBAL_2", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_2` });
      parameters.push({ table: "mangle", chain: "FW_SRT_GLOBAL_3", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_3` });
      parameters.push({ table: "mangle", chain: "FW_SRT_GLOBAL_4", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_4` });
      parameters.push({ table: "mangle", chain: "FW_SRT_GLOBAL_5", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_5` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_GLOBAL_1", target: `${getRuleGroupChainName(targetRgId, "snat")}_1` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_GLOBAL_2", target: `${getRuleGroupChainName(targetRgId, "snat")}_2` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_GLOBAL_3", target: `${getRuleGroupChainName(targetRgId, "snat")}_3` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_GLOBAL_4", target: `${getRuleGroupChainName(targetRgId, "snat")}_4` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_GLOBAL_5", target: `${getRuleGroupChainName(targetRgId, "snat")}_5` });
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: "FW_ALARM_GLOBAL", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
      break;
    }
    case "snat": {
      parameters.push({ table: "nat", chain: `FW_PR_SNAT_GLOBAL_${subPrio}`, target: `SNAT --to-source ${snatIP}`});
      break;
    }
    case "allow": {
      parameters.push({ table: "filter", chain: "FW_FIREWALL_GLOBAL_ALLOW" + chainSuffix, target: upnp ? UPNP_ACCEPT_CHAIN : `MARK --set-xmark ${pid}/0xffff` });
      break;
    }
    case "block":
    default: {
      parameters.push({ table: "filter", chain: "FW_FIREWALL_GLOBAL_BLOCK" + chainSuffix, target: `MARK --set-xmark ${pid}/0xffff` });
    }
  }
  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");
  const localSet = platform.isFireRouterManaged() ? Ipset.CONSTANTS.IPSET_MONITORED_NET : null;
  const localSrcSpec = platform.isFireRouterManaged() ? "src,src" : null;
  const localDstSpec = platform.isFireRouterManaged() ? "dst,dst" : null;
  let owanSet = null;
  if (owanUUID) {
    if (owanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
      const profileId = owanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
      await VPNClient.ensureCreateEnforcementEnv(profileId);
      owanSet = VPNClient.getOifIpsetName(profileId);
    } else {
      const NetworkProfile = require('../net2/NetworkProfile.js');
      await NetworkProfile.ensureCreateEnforcementEnv(owanUUID);
      owanSet = NetworkProfile.getOifIpsetName(owanUUID);
    }
  }

  for (const parameter of parameters) {
    const { table, chain, target, limit } = parameter;
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          // need to use different rules for different combination of connection direction and traffic direction
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        } else {
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        }
        break;
      }
      case "inbound": {
        // inbound filter rules
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        break;
      }
      case "outbound": {
        // outbound filter rules
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        break;
      }
      default:
    }
  }
}

async function setupGenericIdentitiesRules(pid, guids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass) {
  log.verbose(`${createOrDestroy} generic identity rule, guids ${JSON.stringify(guids)}, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}`);
  // generic identity has the same priority level as device
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const parameters = [];
  const filterPrio = 1;
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
      break;
    case Constants.RULE_SEQ_LO:
      chainSuffix = "_LO";
      break;
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      priority = priority || qos.DEFAULT_PRIO;
      qdisc = qdisc || "fq_codel";
      if (ratelimit) {
        let parentHTBQdisc = "3";
        let subclassId = "4";
        if (priority <= qos.PRIO_HIGH) {
          parentHTBQdisc = "2";
          subclassId = "1";
        } else {
          if (priority > qos.PRIO_REG) {
            parentHTBQdisc = "4";
            subclassId = "7";
          }
        }
        if (createOrDestroy === "create") {
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit, priority, qdisc, flowIsolation);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit);
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
        }
      } else {
        let subclassId = qdisc == "fq_codel" ? "5" : "6";
        if (priority <= qos.PRIO_HIGH) {
          subclassId = qdisc == "fq_codel" ? "2" : "3";
        } else {
          if (priority > qos.PRIO_REG) {
            subclassId = qdisc == "fq_codel" ? "8" : "9";
          }
        }
        if (createOrDestroy === "create")
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
      }
      parameters.push({ table: "mangle", chain: `FW_QOS_DEV_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}` });
      break;
    }
    case "route": {
      // policy-based routing can only apply to outbound connection
      direction = "outbound";
      let hardRoute = true;
      if (routeType === "soft")
        hardRoute = false;
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        await VPNClient.ensureCreateEnforcementEnv(profileId);
        // tentatively disable route rule iptables log as it is not used now
        // parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          // parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          // parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
        }
      }
      break;
    }
    case "match_group": {
      await ensureCreateRuleGroupChain(targetRgId);
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_ALLOW", target: getRuleGroupChainName(targetRgId, "allow") });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_BLOCK", target: getRuleGroupChainName(targetRgId, "block") });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_ALLOW_HI", target: getRuleGroupChainName(targetRgId, "allow") + "_HI" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_BLOCK_HI", target: getRuleGroupChainName(targetRgId, "block") + "_HI" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_ALLOW_LO", target: getRuleGroupChainName(targetRgId, "allow") + "_LO" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_BLOCK_LO", target: getRuleGroupChainName(targetRgId, "block") + "_LO" });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_1", target: `${getRuleGroupChainName(targetRgId, "qos")}_1` });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_2", target: `${getRuleGroupChainName(targetRgId, "qos")}_2` });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_3", target: `${getRuleGroupChainName(targetRgId, "qos")}_3` });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_4", target: `${getRuleGroupChainName(targetRgId, "qos")}_4` });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_5", target: `${getRuleGroupChainName(targetRgId, "qos")}_5` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_1", target: `${getRuleGroupChainName(targetRgId, "route")}_1` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_2", target: `${getRuleGroupChainName(targetRgId, "route")}_2` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_3", target: `${getRuleGroupChainName(targetRgId, "route")}_3` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_4", target: `${getRuleGroupChainName(targetRgId, "route")}_4` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_5", target: `${getRuleGroupChainName(targetRgId, "route")}_5` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_1", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_1` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_2", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_2` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_3", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_3` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_4", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_4` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_5", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_5` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_1", target: `${getRuleGroupChainName(targetRgId, "snat")}_1` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_2", target: `${getRuleGroupChainName(targetRgId, "snat")}_2` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_3", target: `${getRuleGroupChainName(targetRgId, "snat")}_3` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_4", target: `${getRuleGroupChainName(targetRgId, "snat")}_4` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_5", target: `${getRuleGroupChainName(targetRgId, "snat")}_5` });
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: "FW_ALARM_DEV", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
      break;
    }
    case "snat": {
      parameters.push({ table: "nat", chain: `FW_PR_SNAT_DEV_${subPrio}`, target: `SNAT --to-source ${snatIP}`});
      break;
    }
    case "allow": {
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_ALLOW" + chainSuffix, target: upnp ? UPNP_ACCEPT_CHAIN : `MARK --set-xmark ${pid}/0xffff` });
      break;
    }
    case "block":
    default: {
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_BLOCK" + chainSuffix, target: `MARK --set-xmark ${pid}/0xffff` });
    }
  }
  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");
  const IdentityManager = require('../net2/IdentityManager.js');

  let owanSet = null;
  if (owanUUID) {
    if (owanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
      const profileId = owanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
      await VPNClient.ensureCreateEnforcementEnv(profileId);
      owanSet = VPNClient.getOifIpsetName(profileId);
    } else {
      const NetworkProfile = require('../net2/NetworkProfile.js');
      await NetworkProfile.ensureCreateEnforcementEnv(owanUUID);
      owanSet = NetworkProfile.getOifIpsetName(owanUUID);
    }
  }

  for (const guid of guids) {
    let localSet4 = null;
    let localSet6 = null;
    const identityClass = IdentityManager.getIdentityClassByGUID(guid);
    if (identityClass) {
      const { ns, uid } = IdentityManager.getNSAndUID(guid);
      await identityClass.ensureCreateEnforcementEnv(uid);
      localSet4 = identityClass.getEnforcementIPsetName(uid, 4);
      localSet6 = identityClass.getEnforcementIPsetName(uid, 6);
    }
    if (!localSet4) {
      log.error(`Cannot find localSet of guid ${guid}`);
      return;
    }
    for (const parameter of parameters) {
      const { table, chain, target, limit } = parameter;
      switch (direction) {
        case "bidirection": {
          // filter rules
          if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
            // need to use different rules for different combination of connection direction and traffic direction
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          } else {
            (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          }
          break;
        }
        case "inbound": {
          // inbound filter rules
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          break;
        }
        case "outbound": {
          // outbound filter rules
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          break;
        }
      }
    }
  }
}

// device-wise rules
async function setupDevicesRules(pid, macAddresses = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass) {
  log.verbose(`${createOrDestroy} device rule, MAC address ${JSON.stringify(macAddresses)}, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const parameters = [];
  const filterPrio = 1;
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
      break;
    case Constants.RULE_SEQ_LO:
      chainSuffix = "_LO";
      break;
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      priority = priority || qos.DEFAULT_PRIO;
      qdisc = qdisc || "fq_codel";
      if (ratelimit) {
        let parentHTBQdisc = "3";
        let subclassId = "4";
        if (priority <= qos.PRIO_HIGH) {
          parentHTBQdisc = "2";
          subclassId = "1";
        } else {
          if (priority > qos.PRIO_REG) {
            parentHTBQdisc = "4";
            subclassId = "7";
          }
        }
        if (createOrDestroy === "create") {
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit, priority, qdisc, flowIsolation);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit);
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
        }
      } else {
        let subclassId = qdisc == "fq_codel" ? "5" : "6";
        if (priority <= qos.PRIO_HIGH) {
          subclassId = qdisc == "fq_codel" ? "2" : "3";
        } else {
          if (priority > qos.PRIO_REG) {
            subclassId = qdisc == "fq_codel" ? "8" : "9";
          }
        }
        if (createOrDestroy === "create")
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
      }
      parameters.push({ table: "mangle", chain: `FW_QOS_DEV_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}` });
      break;
    }
    case "route": {
      // policy-based routing can only apply to outbound connection
      direction = "outbound";
      let hardRoute = true;
      if (routeType === "soft")
        hardRoute = false;
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        await VPNClient.ensureCreateEnforcementEnv(profileId);
        // tentatively disable route rule iptables log as it is not used now
        // parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          // tentatively disable route rule iptables log as it is not used now
          // parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          // tentatively disable route rule iptables log as it is not used now
          // parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
        }
      }
      break;
    }
    case "match_group": {
      await ensureCreateRuleGroupChain(targetRgId);
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_ALLOW", target: getRuleGroupChainName(targetRgId, "allow") });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_BLOCK", target: getRuleGroupChainName(targetRgId, "block") });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_ALLOW_HI", target: getRuleGroupChainName(targetRgId, "allow") + "_HI" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_BLOCK_HI", target: getRuleGroupChainName(targetRgId, "block") + "_HI" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_ALLOW_LO", target: getRuleGroupChainName(targetRgId, "allow") + "_LO" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_BLOCK_LO", target: getRuleGroupChainName(targetRgId, "block") + "_LO" });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_1", target: `${getRuleGroupChainName(targetRgId, "qos")}_1` });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_2", target: `${getRuleGroupChainName(targetRgId, "qos")}_2` });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_3", target: `${getRuleGroupChainName(targetRgId, "qos")}_3` });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_4", target: `${getRuleGroupChainName(targetRgId, "qos")}_4` });
      parameters.push({ table: "mangle", chain: "FW_QOS_DEV_5", target: `${getRuleGroupChainName(targetRgId, "qos")}_5` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_1", target: `${getRuleGroupChainName(targetRgId, "route")}_1` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_2", target: `${getRuleGroupChainName(targetRgId, "route")}_2` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_3", target: `${getRuleGroupChainName(targetRgId, "route")}_3` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_4", target: `${getRuleGroupChainName(targetRgId, "route")}_4` });
      parameters.push({ table: "mangle", chain: "FW_RT_DEVICE_5", target: `${getRuleGroupChainName(targetRgId, "route")}_5` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_1", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_1` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_2", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_2` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_3", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_3` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_4", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_4` });
      parameters.push({ table: "mangle", chain: "FW_SRT_DEVICE_5", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_5` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_1", target: `${getRuleGroupChainName(targetRgId, "snat")}_1` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_2", target: `${getRuleGroupChainName(targetRgId, "snat")}_2` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_3", target: `${getRuleGroupChainName(targetRgId, "snat")}_3` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_4", target: `${getRuleGroupChainName(targetRgId, "snat")}_4` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_5", target: `${getRuleGroupChainName(targetRgId, "snat")}_5` });
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: "FW_ALARM_DEV", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
      break;
    }
    case "snat": {
      parameters.push({ table: "nat", chain: `FW_PR_SNAT_DEV_${subPrio}`, target: `SNAT --to-source ${snatIP}`});
      break;
    }
    case "allow": {
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_ALLOW" + chainSuffix, target: upnp ? UPNP_ACCEPT_CHAIN : `MARK --set-xmark ${pid}/0xffff` });
      break;
    }
    case "block":
    default: {
      parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_BLOCK" + chainSuffix, target: `MARK --set-xmark ${pid}/0xffff` });
    }
  }
  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");

  let owanSet = null;
  if (owanUUID) {
    if (owanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
      const profileId = owanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
      await VPNClient.ensureCreateEnforcementEnv(profileId);
      owanSet = VPNClient.getOifIpsetName(profileId);
    } else {
      const NetworkProfile = require('../net2/NetworkProfile.js');
      await NetworkProfile.ensureCreateEnforcementEnv(owanUUID);
      owanSet = NetworkProfile.getOifIpsetName(owanUUID);
    }
  }

  const Host = require('../net2/Host.js');
  for (const mac of macAddresses) {
    await Host.ensureCreateEnforcementEnv(mac);
    const localSet = Host.getDeviceSetName(mac);
    for (const parameter of parameters) {
      const { table, chain, target, limit } = parameter;
      switch (direction) {
        case "bidirection": {
          // filter rules
          if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
            // need to use different rules for different combination of connection direction and traffic direction
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          } else {
            (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          }
          break;
        }
        case "inbound": {
          // inbound filter rules
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          break;
        }
        case "outbound": {
          // outbound filter rules
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          break;
        }
      }
    }
  }
}

async function setupTagsRules(pid, uids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass) {
  log.verbose(`${createOrDestroy} group rule, policy id ${pid}, group uid ${JSON.stringify(uids)}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const parameters = [];
  const filterPrio = 1;
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
      break;
    case Constants.RULE_SEQ_LO:
      chainSuffix = "_LO";
      break;
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  const Tag = require('../net2/Tag.js');
  for (const uid of uids) {
    await Tag.ensureCreateEnforcementEnv(uid);
    const devSet = Tag.getTagDeviceSetName(uid);
    const netSet = Tag.getTagNetSetName(uid);
    switch (action) {
      case "qos": {
        qdisc = qdisc || "fq_codel";
        if (!qosHandler) {
          throw new Error("Reached QoS rule limit");
        }
        const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
        const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
        priority = priority || qos.DEFAULT_PRIO;
        qdisc = qdisc || "fq_codel";
        if (ratelimit) {
          let parentHTBQdisc = "3";
          let subclassId = "4";
          if (priority <= qos.PRIO_HIGH) {
            parentHTBQdisc = "2";
            subclassId = "1";
          } else {
            if (priority > qos.PRIO_REG) {
              parentHTBQdisc = "4";
              subclassId = "7";
            }
          }
          if (createOrDestroy === "create") {
            await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
            await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit, priority, qdisc, flowIsolation);
            await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
          } else {
            await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
            await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit);
            await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
          }
        } else {
          let subclassId = qdisc == "fq_codel" ? "5" : "6";
          if (priority <= qos.PRIO_HIGH) {
            subclassId = qdisc == "fq_codel" ? "2" : "3";
          } else {
            if (priority > qos.PRIO_REG) {
              subclassId = qdisc == "fq_codel" ? "8" : "9";
            }
          }
          if (createOrDestroy === "create")
            await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
          else
            await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
        }
        parameters.push({ table: "mangle", chain: `FW_QOS_DEV_G_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: `FW_QOS_NET_G_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`, localSet: netSet, localFlagCount: 2 });
        break;
      }
      case "route": {
        // policy-based routing can only apply to outbound connection
        direction = "outbound";
        let hardRoute = true;
        if (routeType === "soft")
          hardRoute = false;
        if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
          const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
          await VPNClient.ensureCreateEnforcementEnv(profileId);
          // tentatively disable route rule iptables log as it is not used now
          // parameters.push({ table: "mangle", chain: `FW_RT_TAG_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: devSet, localFlagCount: 1 });
          // parameters.push({ table: "mangle", chain: `FW_RT_TAG_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: netSet, localFlagCount: 2});
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_DEVICE_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark`, localSet: devSet, localFlagCount: 1 });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_NETWORK_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark`, localSet: netSet, localFlagCount: 2 });
        } else {
          if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
            const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
            const VirtWanGroup = require('../net2/VirtWanGroup.js');
            await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
            // tentatively disable route rule iptables log as it is not used now
            // parameters.push({ table: "mangle", chain: `FW_RT_TAG_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: devSet, localFlagCount: 1 });
            // parameters.push({ table: "mangle", chain: `FW_RT_TAG_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: netSet, localFlagCount: 2 });
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_DEVICE_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark`, localSet: devSet, localFlagCount: 1 });
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_NETWORK_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark`, localSet: netSet, localFlagCount: 2 });
          } else {
            const NetworkProfile = require('../net2/NetworkProfile.js');
            await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
            // tentatively disable route rule iptables log as it is not used now
            // parameters.push({ table: "mangle", chain: `FW_RT_TAG_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: devSet, localFlagCount: 1 });
            // parameters.push({ table: "mangle", chain: `FW_RT_TAG_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: netSet, localFlagCount: 2 });
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_DEVICE_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark`, localSet: devSet, localFlagCount: 1 });
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_NETWORK_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark`, localSet: netSet, localFlagCount: 2 });
          }
        }
        break;
      }
      case "match_group": {
        await ensureCreateRuleGroupChain(targetRgId);
        parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_G_ALLOW", target: getRuleGroupChainName(targetRgId, "allow"), localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_G_BLOCK", target: getRuleGroupChainName(targetRgId, "block"), localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_G_ALLOW", target: getRuleGroupChainName(targetRgId, "allow"), localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_G_BLOCK", target: getRuleGroupChainName(targetRgId, "block"), localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_G_ALLOW_HI", target: getRuleGroupChainName(targetRgId, "allow") + "_HI", localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_G_BLOCK_HI", target: getRuleGroupChainName(targetRgId, "block") + "_HI", localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_G_ALLOW_HI", target: getRuleGroupChainName(targetRgId, "allow") + "_HI", localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_G_BLOCK_HI", target: getRuleGroupChainName(targetRgId, "block") + "_HI", localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_G_ALLOW_LO", target: getRuleGroupChainName(targetRgId, "allow") + "_LO", localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_G_BLOCK_LO", target: getRuleGroupChainName(targetRgId, "block") + "_LO", localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_G_ALLOW_LO", target: getRuleGroupChainName(targetRgId, "allow") + "_LO", localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_G_BLOCK_LO", target: getRuleGroupChainName(targetRgId, "block") + "_LO", localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "filter", chain: "FW_ALARM_DEV_G", target: getRuleGroupChainName(targetRgId, "alarm"), localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_ALARM_NET_G", target: getRuleGroupChainName(targetRgId, "alarm"), localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_QOS_DEV_G_1", target: `${getRuleGroupChainName(targetRgId, "qos")}_1`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_QOS_NET_G_1", target: `${getRuleGroupChainName(targetRgId, "qos")}_1`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_QOS_DEV_G_2", target: `${getRuleGroupChainName(targetRgId, "qos")}_2`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_QOS_NET_G_2", target: `${getRuleGroupChainName(targetRgId, "qos")}_2`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_QOS_DEV_G_3", target: `${getRuleGroupChainName(targetRgId, "qos")}_3`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_QOS_NET_G_3", target: `${getRuleGroupChainName(targetRgId, "qos")}_3`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_QOS_DEV_G_4", target: `${getRuleGroupChainName(targetRgId, "qos")}_4`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_QOS_NET_G_4", target: `${getRuleGroupChainName(targetRgId, "qos")}_4`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_QOS_DEV_G_5", target: `${getRuleGroupChainName(targetRgId, "qos")}_5`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_QOS_NET_G_5", target: `${getRuleGroupChainName(targetRgId, "qos")}_5`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_DEVICE_1", target: `${getRuleGroupChainName(targetRgId, "route")}_1`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_NETWORK_1", target: `${getRuleGroupChainName(targetRgId, "route")}_1`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_DEVICE_2", target: `${getRuleGroupChainName(targetRgId, "route")}_2`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_NETWORK_2", target: `${getRuleGroupChainName(targetRgId, "route")}_2`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_DEVICE_3", target: `${getRuleGroupChainName(targetRgId, "route")}_3`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_NETWORK_3", target: `${getRuleGroupChainName(targetRgId, "route")}_3`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_DEVICE_4", target: `${getRuleGroupChainName(targetRgId, "route")}_4`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_NETWORK_4", target: `${getRuleGroupChainName(targetRgId, "route")}_4`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_DEVICE_5", target: `${getRuleGroupChainName(targetRgId, "route")}_5`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_RT_TAG_NETWORK_5", target: `${getRuleGroupChainName(targetRgId, "route")}_5`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_DEVICE_1", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_1`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_NETWORK_1", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_1`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_DEVICE_2", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_2`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_NETWORK_2", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_2`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_DEVICE_3", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_3`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_NETWORK_3", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_3`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_DEVICE_4", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_4`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_NETWORK_4", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_4`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_DEVICE_5", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_5`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "mangle", chain: "FW_SRT_TAG_NETWORK_5", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_5`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_G_1", target: `${getRuleGroupChainName(targetRgId, "nat")}_1`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_G_1", target: `${getRuleGroupChainName(targetRgId, "nat")}_1`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_G_2", target: `${getRuleGroupChainName(targetRgId, "nat")}_2`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_G_2", target: `${getRuleGroupChainName(targetRgId, "nat")}_2`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_G_3", target: `${getRuleGroupChainName(targetRgId, "nat")}_3`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_G_3", target: `${getRuleGroupChainName(targetRgId, "nat")}_3`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_G_4", target: `${getRuleGroupChainName(targetRgId, "nat")}_4`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_G_4", target: `${getRuleGroupChainName(targetRgId, "nat")}_4`, localSet: netSet, localFlagCount: 2 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_DEV_G_5", target: `${getRuleGroupChainName(targetRgId, "nat")}_5`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_G_5", target: `${getRuleGroupChainName(targetRgId, "nat")}_5`, localSet: netSet, localFlagCount: 2 });
        break;
      }
      case "alarm": {
        parameters.push({ table: "filter", chain: "FW_ALARM_DEV_G", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
        parameters.push({ table: "filter", chain: "FW_ALARM_NET_G", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
        break;
      }
      case "allow": {
        parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_G_ALLOW" + chainSuffix, target: upnp ? UPNP_ACCEPT_CHAIN : `MARK --set-xmark ${pid}/0xffff`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_G_ALLOW" + chainSuffix, target: upnp ? UPNP_ACCEPT_CHAIN : `MARK --set-xmark ${pid}/0xffff`, localSet: netSet, localFlagCount: 2 });
        break;
      }
      case "snat": {
        parameters.push({ table: "nat", chain: `FW_PR_SNAT_DEV_G_${subPrio}`, target: `SNAT --to-source ${snatIP}`});
        parameters.push({ table: "nat", chain: `FW_PR_SNAT_NET_G_${subPrio}`, target: `SNAT --to-source ${snatIP}`});
        break;
      }
      case "block":
      default: {
        parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_G_BLOCK" + chainSuffix, target: `MARK --set-xmark ${pid}/0xffff`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_G_BLOCK" + chainSuffix, target: `MARK --set-xmark ${pid}/0xffff`, localSet: netSet, localFlagCount: 2 });
      }
    }
  }

  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");

  let owanSet = null;
  if (owanUUID) {
    if (owanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
      const profileId = owanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
      await VPNClient.ensureCreateEnforcementEnv(profileId);
      owanSet = VPNClient.getOifIpsetName(profileId);
    } else {
      const NetworkProfile = require('../net2/NetworkProfile.js');
      await NetworkProfile.ensureCreateEnforcementEnv(owanUUID);
      owanSet = NetworkProfile.getOifIpsetName(owanUUID);
    }
  }


  for (const parameter of parameters) {
    const { table, chain, target, limit, localSet, localFlagCount } = parameter;
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        } else {
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        }
        break;
      }
      case "inbound": {
        // filter rules
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        break;
      }
      case "outbound": {
        // filter rules
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        break;
      }
    }
  }
}

async function setupIntfsRules(pid, uuids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass) {
  log.verbose(`${createOrDestroy} network rule, policy id ${pid}, uuid ${JSON.stringify(uuids)}, local port ${localPortSet}, remote set ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}`);
  if (_.isEmpty(uuids))
    return;
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const parameters = [];
  const filterPrio = 1;
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
      break;
    case Constants.RULE_SEQ_LO:
      chainSuffix = "_LO";
      break;
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      priority = priority || qos.DEFAULT_PRIO;
      qdisc = qdisc || "fq_codel";
      if (ratelimit) {
        let parentHTBQdisc = "3";
        let subclassId = "4";
        if (priority <= qos.PRIO_HIGH) {
          parentHTBQdisc = "2";
          subclassId = "1";
        } else {
          if (priority > qos.PRIO_REG) {
            parentHTBQdisc = "4";
            subclassId = "7";
          }
        }
        if (createOrDestroy === "create") {
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit, priority, qdisc, flowIsolation);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit);
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
        }
      } else {
        let subclassId = qdisc == "fq_codel" ? "5" : "6";
        if (priority <= qos.PRIO_HIGH) {
          subclassId = qdisc == "fq_codel" ? "2" : "3";
        } else {
          if (priority > qos.PRIO_REG) {
            subclassId = qdisc == "fq_codel" ? "8" : "9";
          }
        }
        if (createOrDestroy === "create")
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
      }
      parameters.push({ table: "mangle", chain: `FW_QOS_NET_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}` });
      break;
    }
    case "route": {
      // policy-based routing can only apply to outbound connection
      direction = "outbound";
      let hardRoute = true;
      if (routeType === "soft")
        hardRoute = false;
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        await VPNClient.ensureCreateEnforcementEnv(profileId);
        // tentatively disable route rule iptables log as it is not used now
        // parameters.push({ table: "mangle", chain: `FW_RT_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_NETWORK_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          // tentatively disable route rule iptables log as it is not used now
          // parameters.push({ table: "mangle", chain: `FW_RT_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_NETWORK_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          // tentatively disable route rule iptables log as it is not used now
          // parameters.push({ table: "mangle", chain: `FW_RT_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_NETWORK_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
        }
      }
      break;
    }
    case "match_group": {
      await ensureCreateRuleGroupChain(targetRgId);
      parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_ALLOW", target: getRuleGroupChainName(targetRgId, "allow") });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_BLOCK", target: getRuleGroupChainName(targetRgId, "block") });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_ALLOW_HI", target: getRuleGroupChainName(targetRgId, "allow") + "_HI" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_BLOCK_HI", target: getRuleGroupChainName(targetRgId, "block") + "_HI" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_ALLOW_LO", target: getRuleGroupChainName(targetRgId, "allow") + "_LO" });
      parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_BLOCK_LO", target: getRuleGroupChainName(targetRgId, "block") + "_LO" });
      parameters.push({ table: "mangle", chain: "FW_QOS_NET_1", target: `${getRuleGroupChainName(targetRgId, "qos")}_1` });
      parameters.push({ table: "mangle", chain: "FW_QOS_NET_2", target: `${getRuleGroupChainName(targetRgId, "qos")}_2` });
      parameters.push({ table: "mangle", chain: "FW_QOS_NET_3", target: `${getRuleGroupChainName(targetRgId, "qos")}_3` });
      parameters.push({ table: "mangle", chain: "FW_QOS_NET_4", target: `${getRuleGroupChainName(targetRgId, "qos")}_4` });
      parameters.push({ table: "mangle", chain: "FW_QOS_NET_5", target: `${getRuleGroupChainName(targetRgId, "qos")}_5` });
      parameters.push({ table: "mangle", chain: "FW_RT_NETWORK_1", target: `${getRuleGroupChainName(targetRgId, "route")}_1` });
      parameters.push({ table: "mangle", chain: "FW_RT_NETWORK_2", target: `${getRuleGroupChainName(targetRgId, "route")}_2` });
      parameters.push({ table: "mangle", chain: "FW_RT_NETWORK_3", target: `${getRuleGroupChainName(targetRgId, "route")}_3` });
      parameters.push({ table: "mangle", chain: "FW_RT_NETWORK_4", target: `${getRuleGroupChainName(targetRgId, "route")}_4` });
      parameters.push({ table: "mangle", chain: "FW_RT_NETWORK_5", target: `${getRuleGroupChainName(targetRgId, "route")}_5` });
      parameters.push({ table: "mangle", chain: "FW_SRT_NETWORK_1", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_1` });
      parameters.push({ table: "mangle", chain: "FW_SRT_NETWORK_2", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_2` });
      parameters.push({ table: "mangle", chain: "FW_SRT_NETWORK_3", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_3` });
      parameters.push({ table: "mangle", chain: "FW_SRT_NETWORK_4", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_4` });
      parameters.push({ table: "mangle", chain: "FW_SRT_NETWORK_5", target: `${getRuleGroupChainName(targetRgId, "soft_route")}_5` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_1", target: `${getRuleGroupChainName(targetRgId, "snat")}_1` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_2", target: `${getRuleGroupChainName(targetRgId, "snat")}_2` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_3", target: `${getRuleGroupChainName(targetRgId, "snat")}_3` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_4", target: `${getRuleGroupChainName(targetRgId, "snat")}_4` });
      parameters.push({ table: "nat", chain: "FW_PR_SNAT_NET_5", target: `${getRuleGroupChainName(targetRgId, "snat")}_5` });
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: "FW_ALARM_NET", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
      break;
    }
    case "snat": {
      parameters.push({ table: "nat", chain: `FW_PR_SNAT_NET_${subPrio}`, target: `SNAT --to-source ${snatIP}`});
      break;
    }
    case "allow": {
      parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_ALLOW" + chainSuffix, target: upnp ? UPNP_ACCEPT_CHAIN : `MARK --set-xmark ${pid}/0xffff` });
      break;
    }
    case "block":
    default: {
      parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_BLOCK" + chainSuffix, target: `MARK --set-xmark ${pid}/0xffff` });
    }
  }
  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");

  let owanSet = null;
  if (owanUUID) {
    if (owanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
      const profileId = owanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
      await VPNClient.ensureCreateEnforcementEnv(profileId);
      owanSet = VPNClient.getOifIpsetName(profileId);
    } else {
      const NetworkProfile = require('../net2/NetworkProfile.js');
      await NetworkProfile.ensureCreateEnforcementEnv(owanUUID);
      owanSet = NetworkProfile.getOifIpsetName(owanUUID);
    }
  }

  const NetworkProfile = require('../net2/NetworkProfile.js');
  for (const uuid of uuids) {
    await NetworkProfile.ensureCreateEnforcementEnv(uuid);
    const localSet4 = NetworkProfile.getNetIpsetName(uuid, 4);
    const localSet6 = NetworkProfile.getNetIpsetName(uuid, 6);
    for (const parameter of parameters) {
      const { table, chain, target, limit } = parameter;
      switch (direction) {
        case "bidirection": {
          // filter rules
          if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
            // need to use different rules for different combination of connection direction and traffic direction
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          } else {
            (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
            (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
            (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          }
          break;
        }
        case "inbound": {
          // inbound filter rules
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          break;
        }
        case "outbound": {
          // outbound filter rules
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          break;
        }
      }
    }
  }
}

async function setupRuleGroupRules(pid, ruleGroupUUID, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, reverse1, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass) {
  log.verbose(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, parent rule group UUID ${ruleGroupUUID}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const filterPrio = 1;
  const parameters = [];
  await ensureCreateRuleGroupChain(ruleGroupUUID);
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
      break;
    case Constants.RULE_SEQ_LO:
      chainSuffix = "_LO";
      break;
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      priority = priority || qos.DEFAULT_PRIO;
      qdisc = qdisc || "fq_codel";
      if (ratelimit) {
        let parentHTBQdisc = "3";
        let subclassId = "4";
        if (priority <= qos.PRIO_HIGH) {
          parentHTBQdisc = "2";
          subclassId = "1";
        } else {
          if (priority > qos.PRIO_REG) {
            parentHTBQdisc = "4";
            subclassId = "7";
          }
        }
        if (createOrDestroy === "create") {
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit, priority, qdisc, flowIsolation);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, ratelimit);
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
        }
      } else {
        let subclassId = qdisc == "fq_codel" ? "5" : "6";
        if (priority <= qos.PRIO_HIGH) {
          subclassId = qdisc == "fq_codel" ? "2" : "3";
        } else {
          if (priority > qos.PRIO_REG) {
            subclassId = qdisc == "fq_codel" ? "8" : "9";
          }
        }
        if (createOrDestroy === "create")
          await qos.createTCFilter(qosHandler, "1", subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, "1", trafficDirection, filterPrio, fwmark);
      }
      parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "qos")}_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}` });
      break;
    }
    case "route": {
      // TODO: support route in rule group member rules
      direction = "outbound";
      let hardRoute = true;
      if (routeType === "soft")
        hardRoute = false;
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        await VPNClient.ensureCreateEnforcementEnv(profileId);
        // tentatively disable route rule iptables log as it is not used now
        // parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "route")}_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, hardRoute ? "route" : "soft_route")}_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          // tentatively disable route rule iptables log as it is not used now
          // parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "route")}_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, hardRoute ? "route" : "soft_route")}_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          // tentatively disable route rule iptables log as it is not used now
          // parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "route")}_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, hardRoute ? "route" : "soft_route")}_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
        }
      }
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: getRuleGroupChainName(ruleGroupUUID, "alarm"), target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
      break;
    }
    case "snat": {
      parameters.push({ table: "nat", chain: `${getRuleGroupChainName(ruleGroupUUID, "snat")}_${subPrio}`, target: `SNAT --to-source ${snatIP}`});
      break;
    }
    case "allow": {
      parameters.push({ table: "filter", chain: getRuleGroupChainName(ruleGroupUUID, "allow") + chainSuffix, target: upnp ? UPNP_ACCEPT_CHAIN : `MARK --set-xmark ${pid}/0xffff` });
      break;
    }
    case "block":
    default: {
      parameters.push({ table: "filter", chain: getRuleGroupChainName(ruleGroupUUID, "block") + chainSuffix, target: `MARK --set-xmark ${pid}/0xffff` });
    }
  }
  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");
  const localSet = platform.isFireRouterManaged() ? Ipset.CONSTANTS.IPSET_MONITORED_NET : null;
  const localSrcSpec = platform.isFireRouterManaged() ? "src,src" : null;
  const localDstSpec = platform.isFireRouterManaged() ? "dst,dst" : null;

  let owanSet = null;
  if (owanUUID) {
    if (owanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
      const profileId = owanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
      await VPNClient.ensureCreateEnforcementEnv(profileId);
      owanSet = VPNClient.getOifIpsetName(profileId);
    } else {
      const NetworkProfile = require('../net2/NetworkProfile.js');
      await NetworkProfile.ensureCreateEnforcementEnv(owanUUID);
      owanSet = NetworkProfile.getOifIpsetName(owanUUID);
    }
  }

  for (const parameter of parameters) {
    const { table, chain, target, limit } = parameter;
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          // need to use different rules for different combination of connection direction and traffic direction
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        } else {
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, limit, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
          (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, limit, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        }
        break;
      }
      case "inbound": {
        // inbound filter rules
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        break;
      }
      case "outbound": {
        // outbound filter rules
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, limit, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "upload") && await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, null, owanSet, origDst, origDport, dscpClass);
        (!dscpClass || !trafficDirection || trafficDirection === "download") && await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, limit, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost, owanSet, null, origDst, origDport, dscpClass);
        break;
      }
      default:
    }
  }
}

async function manipulateFiveTupleRule(action, srcMatchingSet, srcSpec, srcPositive = true, srcPortSet, dstMatchingSet, dstSpec, dstPositive = true, dstPortSet, proto, ctDir, target, chain, table, limit, af = 4, comment, ctstate, transferredBytes, transferredPackets, avgPacketBytes, transferDirection, tlsHostSet, tlsHost, iifSet, oifSet, origDst, origDport, dscpClass) {
  // sport and dport can be range string, e.g., 10000-20000
  const rule = new Rule(table).fam(af).chn(chain);
  if (srcMatchingSet)
    rule.mdl("set", `${srcPositive ? "" : "!"} --match-set ${srcMatchingSet} ${srcSpec}`);
  if (srcPortSet)
    rule.mdl("set", `--match-set ${srcPortSet} src`);
  if (dstMatchingSet)
    rule.mdl("set", `${dstPositive ? "" : "!"} --match-set ${dstMatchingSet} ${dstSpec}`);
  if (dstPortSet)
    rule.mdl("set", `--match-set ${dstPortSet} dst`);
  if (iifSet)
    rule.mdl("set", `--match-set ${iifSet} src,src`);
  if (oifSet)
    rule.mdl("set", `--match-set ${oifSet} dst,dst`);
  if (origDst)
    rule.mdl("conntrack", `--ctorigdst ${origDst}`);
  if (origDport)
    rule.mdl("conntrack", `--ctorigdstport ${origDport}`);
  if (proto)
    rule.pro(proto);
  if (ctDir)
    rule.mdl("conntrack", `--ctdir ${ctDir}`);
  if (comment)
    rule.mdl("comment", `--comment ${comment}`);
  if (ctstate)
    rule.mdl("conntrack", `--ctstate ${ctstate}`);
  if (transferDirection) {
    if (transferredBytes)
      rule.mdl("connbytes", `--connbytes ${transferredBytes} --connbytes-dir ${transferDirection} --connbytes-mode bytes`);
    if (transferredPackets)
      rule.mdl("connbytes", `--connbytes ${transferredPackets} --connbytes-dir ${transferDirection} --connbytes-mode packets`);
    if (avgPacketBytes)
      rule.mdl("connbytes", `--connbytes ${avgPacketBytes} --connbytes-dir ${transferDirection} --connbytes-mode avgpkt`);
  }
  if (tlsHostSet) {
    rule.mdl("tls", `--tls-hostset ${tlsHostSet}`)
  }
  if (tlsHost) {
    rule.mdl("tls", `--tls-host ${tlsHost}`)
  }
  if (limit) {
    const [count, unit] = limit.split("/");
    const burstRatio = 2;
    const burstCount = parseInt(count) * burstRatio;
    rule.mdl("hashlimit", `--hashlimit-upto ${limit} --hashlimit-mode srcip --hashlimit-burst ${burstCount} --hashlimit-name fw_route`)
  }
  if (dscpClass) {
    rule.mdl("dscp", `--dscp-class ${dscpClass}`);
  }
  rule.jmp(target);
  await exec(rule.toCmd(action));
}


module.exports = {
  setupBlockChain,
  batchBlock,
  batchUnblock,
  batchBlockNetPort,
  block,
  unblock,
  setupCategoryEnv,
  setupGlobalRules,
  setupDevicesRules,
  setupGenericIdentitiesRules,
  getTLSHostSet,
  getDstSet,
  getDstSet6,
  getMacSet,
  existsBlockingEnv,
  setupTagsRules,
  setupIntfsRules,
  setupRuleGroupRules,
  manipulateFiveTupleRule,
  VPN_CLIENT_WAN_PREFIX,
  VIRT_WAN_GROUP_PREFIX
}
