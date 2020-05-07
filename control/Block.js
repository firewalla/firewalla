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


async function setupCategoryEnv(category, dstType = "hash:ip", hashSize = 128) {
  if(!category) {
    return;
  }

  const ipset = getDstSet(category);
  const tempIpset = getDstSet(`tmp_${category}`);
  const ipset6 = getDstSet6(category);
  const tempIpset6 = getDstSet6(`tmp_${category}`);

  const cmdCreateCategorySet = `sudo ipset create -! ${ipset} ${dstType} family inet hashsize ${hashSize} maxelem 65536`
  const cmdCreateCategorySet6 = `sudo ipset create -! ${ipset6} ${dstType} family inet6 hashsize ${hashSize} maxelem 65536`
  const cmdCreateTempCategorySet = `sudo ipset create -! ${tempIpset} ${dstType} family inet hashsize ${hashSize} maxelem 65536`
  const cmdCreateTempCategorySet6 = `sudo ipset create -! ${tempIpset6} ${dstType} family inet6 hashsize ${hashSize} maxelem 65536`

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

async function setupGlobalRules(pid, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, allowOrBlock = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null) {
  log.info(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${allowOrBlock}, direction ${direction}, ctstate ${ctstate}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const filterChain = allowOrBlock === "block" ? "FW_FIREWALL_GLOBAL_BLOCK" : "FW_FIREWALL_GLOBAL_ALLOW";
  const natChain = allowOrBlock === "block" ? "FW_NAT_FIREWALL_GLOBAL_BLOCK" : "FW_NAT_FIREWALL_GLOBAL_ALLOW";
  const filterTarget = allowOrBlock === "block" ? "FW_DROP" : "FW_ACCEPT";
  const natTarget = allowOrBlock === "block" ? "FW_NAT_HOLE" : "ACCEPT";
  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");
  
  switch (direction) {
    case "bidirection": {
      // filter rules
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, null, filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, null, filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
      // nat rules
      /* do not apply firewall rules in NAT table since the connection information may be incomplete in PREROUTING stage
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, null, natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, null, natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
      */
      break;
    }
    case "inbound": {
      // inbound filter rules
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
      // inbound nat rules
      /*
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
      */
      break;
    }
    case "outbound": {
      // outbound filter rules
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, "REPLY", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, "REPLY", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
      // outbound nat rules
      /*
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, "REPLY", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, null, null, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
      await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, null, null, true, localPortSet, proto, "REPLY", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
      */
      break;
    }
    default:
  }
    
}

// device-wise rules
async function setupDevicesRules(pid, macAddresses = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, allowOrBlock = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null) {
  log.info(`${createOrDestroy} device rule, policy id ${pid}, MAC address ${JSON.stringify(macAddresses)}, local port ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${allowOrBlock}, direction ${direction}, ctstate ${ctstate}`);
  if (_.isEmpty(macAddresses))
    return;
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const filterChain = allowOrBlock === "block" ? "FW_FIREWALL_DEV_BLOCK" : "FW_FIREWALL_DEV_ALLOW";
  const natChain = allowOrBlock === "block" ? "FW_NAT_FIREWALL_DEV_BLOCK" : "FW_NAT_FIREWALL_DEV_ALLOW";
  const filterTarget = allowOrBlock === "block" ? "FW_DROP" : "FW_ACCEPT";
  const natTarget = allowOrBlock === "block" ? "FW_NAT_HOLE" : "ACCEPT";
  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");

  const Host = require('../net2/Host.js');
  for (const mac of macAddresses) {
    await Host.ensureCreateDeviceIpset(mac);
    const localSet = Host.getDeviceSetName(mac);
    switch (direction) {
      case "bidirection": {
        // filter rules
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        // nat rules
        /*
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        */
        break;
      }
      case "inbound": {
        // inbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        // inbound nat rules
        /*
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        */
        break;
      }
      case "outbound": {
        // outbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        // outbound nat rules
        /*
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        */
        break;
      }
    }
  }
}

async function setupTagsRules(pid, uids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, allowOrBlock = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null) {
  log.info(`${createOrDestroy} group rule, policy id ${pid}, group uid ${JSON.stringify(uids)}, local port ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${allowOrBlock}, direction ${direction}, ctstate ${ctstate}`);
  if (_.isEmpty(uids))
    return;
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const filterDevChain = allowOrBlock === "block" ? "FW_FIREWALL_DEV_G_BLOCK" : "FW_FIREWALL_DEV_G_ALLOW";
  const filterNetChain = allowOrBlock === "block" ? "FW_FIREWALL_NET_G_BLOCK" : "FW_FIREWALL_NET_G_ALLOW";
  const natDevChain = allowOrBlock === "block" ? "FW_NAT_FIREWALL_DEV_G_BLOCK" : "FW_NAT_FIREWALL_DEV_G_ALLOW";
  const natNetChain = allowOrBlock === "block" ? "FW_NAT_FIREWALL_NET_G_BLOCK" : "FW_NAT_FIREWALL_NET_G_ALLOW";
  const filterTarget = allowOrBlock === "block" ? "FW_DROP" : "FW_ACCEPT";
  const natTarget = allowOrBlock === "block" ? "FW_NAT_HOLE" : "ACCEPT";
  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");

  const Tag = require('../net2/Tag.js');
  for (const uid of uids) {
    await Tag.ensureCreateEnforcementEnv(uid);
    const devSet = Tag.getTagDeviceSetName(uid);
    const netSet = Tag.getTagNetSetName(uid);
    switch (direction) {
      case "bidirection": {
        // filter rules
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterDevChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, null, filterTarget, filterDevChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterDevChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, null, filterTarget, filterDevChain, "filter", 6, `rule_${pid}`, ctstate);

        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterNetChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, null, filterTarget, filterNetChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterNetChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, null, filterTarget, filterNetChain, "filter", 6, `rule_${pid}`, ctstate);
        // nat rules
        /*
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natDevChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, null, natTarget, natDevChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natDevChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, null, natTarget, natDevChain, "nat", 6, `rule_${pid}`, ctstate);

        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natNetChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, null, natTarget, natNetChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natNetChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, null, natTarget, natNetChain, "nat", 6, `rule_${pid}`, ctstate);
        */
        break;
      }
      case "inbound": {
        // filter rules
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterDevChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "ORIGINAL", filterTarget, filterDevChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterDevChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "ORIGINAL", filterTarget, filterDevChain, "filter", 6, `rule_${pid}`, ctstate);

        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterNetChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "ORIGINAL", filterTarget, filterNetChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterNetChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "ORIGINAL", filterTarget, filterNetChain, "filter", 6, `rule_${pid}`, ctstate);
        // nat rules
        /*
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natDevChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "ORIGINAL", natTarget, natDevChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natDevChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "ORIGINAL", natTarget, natDevChain, "nat", 6, `rule_${pid}`, ctstate);

        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natNetChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "ORIGINAL", natTarget, natNetChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natNetChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "ORIGINAL", natTarget, natNetChain, "nat", 6, `rule_${pid}`, ctstate);
        */
        break;
      }
      case "outbound": {
        // filter rules
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterDevChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "REPLY", filterTarget, filterDevChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterDevChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "REPLY", filterTarget, filterDevChain, "filter", 6, `rule_${pid}`, ctstate);

        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterNetChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "REPLY", filterTarget, filterNetChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterNetChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "REPLY", filterTarget, filterNetChain, "filter", 6, `rule_${pid}`, ctstate);
        // nat rules
        /*
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natDevChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "REPLY", natTarget, natDevChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natDevChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "REPLY", natTarget, natDevChain, "nat", 6, `rule_${pid}`, ctstate);

        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natNetChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "REPLY", natTarget, natNetChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natNetChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "REPLY", natTarget, natNetChain, "nat", 6, `rule_${pid}`, ctstate);
        */
        break;
      }
    }
  }
}

async function setupIntfsRules(pid, uuids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, allowOrBlock = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null) {
  log.info(`${createOrDestroy} network rule, policy id ${pid}, uuid ${JSON.stringify(uuids)}, local port ${localPortSet}, remote set ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${allowOrBlock}, direction ${direction}, ctstate ${ctstate}`);
  if (_.isEmpty(uuids))
    return;
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const filterChain = allowOrBlock === "block" ? "FW_FIREWALL_NET_BLOCK" : "FW_FIREWALL_NET_ALLOW";
  const natChain = allowOrBlock === "block" ? "FW_NAT_FIREWALL_NET_BLOCK" : "FW_NAT_FIREWALL_NET_ALLOW";
  const filterTarget = allowOrBlock === "block" ? "FW_DROP" : "FW_ACCEPT";
  const natTarget = allowOrBlock === "block" ? "FW_NAT_HOLE" : "ACCEPT";
  const remoteSrcSpecs = [];
  const remoteDstSpecs = [];

  for (let i = 0; i != remoteTupleCount; i++) {
    remoteSrcSpecs.push("src");
    remoteDstSpecs.push("dst");
  }

  const remoteSrcSpec = remoteSrcSpecs.join(",");
  const remoteDstSpec = remoteDstSpecs.join(",");
  
  const NetworkProfile = require('../net2/NetworkProfile.js');
  for (const uuid of uuids) {
    await NetworkProfile.ensureCreateEnforcementEnv(uuid);
    const localSet4 = NetworkProfile.getNetIpsetName(uuid, 4);
    const localSet6 = NetworkProfile.getNetIpsetName(uuid, 6);
    switch (direction) {
      case "bidirection": {
        // filter rules
        await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, null, filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, null, filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        // nat rules
        /*
        await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, null, natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, null, natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        */
        break;
      }
      case "inbound": {
        // inbound filter rules
        await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        // inbound nat rules
        /*
        await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        */
        break;
      }
      case "outbound": {
        // outbound filter rules
        await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "REPLY", filterTarget, filterChain, "filter", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "REPLY", filterTarget, filterChain, "filter", 6, `rule_${pid}`, ctstate);
        // outbound nat rules
        /*
        await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "REPLY", natTarget, natChain, "nat", 4, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "REPLY", natTarget, natChain, "nat", 6, `rule_${pid}`, ctstate);
        */
        break;
      }
    }
  }
}

async function manipulateFiveTupleRule(action, srcMatchingSet, srcSpec, srcPositive = true, srcPortSet, dstMatchingSet, dstSpec, dstPositive = true, dstPortSet, proto, ctDir, target, chain, table, af = 4, comment, ctstate) {
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
  if (proto)
    rule.pro(proto);
  if (ctDir)
    rule.mdl("conntrack", `--ctdir ${ctDir}`);
  if (comment)
    rule.mdl("comment", `--comment ${comment}`);
  if (ctstate)
    rule.mdl("conntrack", `--ctstate ${ctstate}`);
  rule.jmp(target);
  await exec(rule.toCmd(action));
}


module.exports = {
  setupBlockChain:setupBlockChain,
  block: block,
  unblock: unblock,
  setupCategoryEnv: setupCategoryEnv,
  setupGlobalRules: setupGlobalRules,
  setupDevicesRules: setupDevicesRules,
  getDstSet: getDstSet,
  getDstSet6: getDstSet6,
  getMacSet: getMacSet,
  existsBlockingEnv: existsBlockingEnv,
  setupTagsRules: setupTagsRules,
  setupIntfsRules: setupIntfsRules,
  manipulateFiveTupleRule: manipulateFiveTupleRule
}
