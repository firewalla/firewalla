/*    Copyright 2016-2020 Firewalla Inc.
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
const routing = require('../extension/routing/routing.js');

const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');
const VPN_CLIENT_WAN_PREFIX = "VC:";

const initializedRuleGroups = {};

// =============== block @ connection level ==============

async function ensureCreateRuleGroupChain(uuid) {
  if (initializedRuleGroups[uuid] === 1)
    return;
  const cmds = [
    `sudo iptables -w -t filter -N ${getRuleGroupChainName(uuid, "allow")} &> /dev/null`,
    `sudo iptables -w -t filter -N ${getRuleGroupChainName(uuid, "block")} &> /dev/null`,
    `sudo ip6tables -w -t filter -N ${getRuleGroupChainName(uuid, "allow")} &> /dev/null`,
    `sudo ip6tables -w -t filter -N ${getRuleGroupChainName(uuid, "block")} &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")} &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "qos")} &> /dev/null`,
    `sudo iptables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")} &> /dev/null`,
    `sudo ip6tables -w -t mangle -N ${getRuleGroupChainName(uuid, "route")} &> /dev/null`,
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
    case "route":
      return `FW_RG_${uuid.substring(0, 13)}_ROUTE`;
      case "allow":
      return `FW_RG_${uuid.substring(0, 13)}_ALLOW`;
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
    setupCategoryEnv("default_c", "hash:ip", 4096),
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

function getDropChain(security) {
  return security ? 'FW_SEC_DROP' : 'FW_DROP'
}

async function setupCategoryEnv(category, dstType = "hash:ip", hashSize = 128) {
  if(!category) {
    return;
  }

  const CategoryUpdater = require('./CategoryUpdater.js');
  const categoryUpdater = new CategoryUpdater();

  const ipset = categoryUpdater.getIPSetName(category);
  const tempIpset = categoryUpdater.getTempIPSetName(category);
  const ipset6 = categoryUpdater.getIPSetNameForIPV6(category);
  const tempIpset6 = categoryUpdater.getTempIPSetNameForIPV6(category);

  const staticIpset = categoryUpdater.getIPSetName(category, true);
  const tempStaticIpset = categoryUpdater.getTempIPSetName(category, true);
  const staticIpset6 = categoryUpdater.getIPSetNameForIPV6(category, true);
  const tempStaticIpset6 = categoryUpdater.getTempIPSetNameForIPV6(category, true);

  const cmdCreateCategorySet = `sudo ipset create -! ${ipset} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet hashsize ${hashSize} maxelem 65536`}`
  const cmdCreateCategorySet6 = `sudo ipset create -! ${ipset6} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet6 hashsize ${hashSize} maxelem 65536`}`
  const cmdCreateTempCategorySet = `sudo ipset create -! ${tempIpset} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet hashsize ${hashSize} maxelem 65536`}`
  const cmdCreateTempCategorySet6 = `sudo ipset create -! ${tempIpset6} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet6 hashsize ${hashSize} maxelem 65536`}`

  const cmdCreateStaticCategorySet = `sudo ipset create -! ${staticIpset} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet hashsize ${hashSize} maxelem 65536`}`
  const cmdCreateStaticCategorySet6 = `sudo ipset create -! ${staticIpset6} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet6 hashsize ${hashSize} maxelem 65536`}`
  const cmdCreateTempStaticCategorySet = `sudo ipset create -! ${tempStaticIpset} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet hashsize ${hashSize} maxelem 65536`}`
  const cmdCreateTempStaticCategorySet6 = `sudo ipset create -! ${tempStaticIpset6} ${dstType} ${dstType === "bitmap:port" ? "range 0-65535" : `family inet6 hashsize ${hashSize} maxelem 65536`}`

  await exec(cmdCreateCategorySet);
  await exec(cmdCreateCategorySet6);
  await exec(cmdCreateTempCategorySet);
  await exec(cmdCreateTempCategorySet6);

  await exec(cmdCreateStaticCategorySet);
  await exec(cmdCreateStaticCategorySet6);
  await exec(cmdCreateTempStaticCategorySet);
  await exec(cmdCreateTempStaticCategorySet6);
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

function batchBlock(elements, ipset) {
  return batchSetupIpset(elements, ipset);
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

async function batchSetupIpset(elements, ipset, remove = false) {
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
      cmds.push(`${op} ${v4Set} ${ipAddr}`);
    } else {
      const ip6 = new Address6(ipAddr);
      if (ip6.isValid() && ip6.correctForm() != '::') {
        cmds.push(`${op} ${v6Set} ${ipAddr}`);
      }
    }
  }
  log.debug(`Batch setup IP set ${op}`, cmds);
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

async function setupGlobalRules(pid, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG) {
  log.info(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, target rule group UUID ${targetRgId}, rule seq ${seq}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const parameters = [];
  const filterPrio = 1;
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
      break;
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      const qosHandler = await qos.allocateQoSHanderForPolicy(pid);
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
        await qos.deallocateQoSHandlerForPolicy(pid);
      }
      parameters.push({table: "mangle", chain: "FW_QOS_GLOBAL", target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`});
      break;
    }
    case "route": {
      // policy-based routing can only apply to outbound connection
      direction = "outbound";
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        const ovpnClient = new OpenVPNClient({profileId: profileId});
        const intf = ovpnClient.getInterfaceName();
        const rtId = await vpnClientEnforcer.getRtId(intf);
        if (!rtId) {
          log.error(`Cannot find rtId of VPN client ${profileId}`);
          return;
        }
        const rtIdHex = Number(rtId).toString(16);
        parameters.push({table: "mangle", chain: "FW_RT_VC_GLOBAL", target: `MARK --set-xmark 0x${rtIdHex}/${routing.MASK_VC}`});
      } else {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        parameters.push({table: "mangle", chain: "FW_RT_REG_GLOBAL", target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`})
      }
      break;
    }
    case "match_group": {
      await ensureCreateRuleGroupChain(targetRgId);
      parameters.push({table: "filter", chain: "FW_FIREWALL_GLOBAL_ALLOW" + chainSuffix, target: getRuleGroupChainName(targetRgId, "allow")});
      parameters.push({table: "filter", chain: "FW_FIREWALL_GLOBAL_BLOCK" + chainSuffix, target: getRuleGroupChainName(targetRgId, "block")});
      parameters.push({table: "mangle", chain: "FW_QOS_GLOBAL", target: getRuleGroupChainName(targetRgId, "qos")});
      parameters.push({table: "mangle", chain: "FW_RT_VC_GLOBAL", target: getRuleGroupChainName(targetRgId, "route")});
      parameters.push({table: "mangle", chain: "FW_RT_REG_GLOBAL", target: getRuleGroupChainName(targetRgId, "route")});
      break;
    }
    case "allow": {
      parameters.push({table: "filter", chain: "FW_FIREWALL_GLOBAL_ALLOW" + chainSuffix, target: "FW_ACCEPT"});
      break;
    }
    case "block":
    default: {
      parameters.push({table: "filter", chain: "FW_FIREWALL_GLOBAL_BLOCK" + chainSuffix, target: getDropChain(security)});
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

  for (const parameter of parameters) {
    const {table, chain, target} = parameter;
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          // need to use different rules for different combination of connection direction and traffic direction
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
        } else {
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
        }
        break;
      }
      case "inbound": {
        // inbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        break;
      }
      case "outbound": {
        // outbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        break;
      }
      default:
    }
  }
}

async function setupGenericIdentitiesRules(pid, uids = [], identityType, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG) {
  log.info(`${createOrDestroy} generic identity rule, unique ids ${JSON.stringify(uids)}, identity type ${identityType}, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, target rule group UUID ${targetRgId}, rule seq ${seq}`);
  // generic identity has the same priority level as device
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const parameters = [];
  const filterPrio = 1;
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
      break;
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      const qosHandler = await qos.allocateQoSHanderForPolicy(pid);
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
        await qos.deallocateQoSHandlerForPolicy(pid);
      }
      parameters.push({table: "mangle", chain: "FW_QOS_DEV_G", target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`});
      break;
    }
    case "route": {
      // policy-based routing can only apply to outbound connection
      direction = "outbound";
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        const ovpnClient = new OpenVPNClient({profileId: profileId});
        const intf = ovpnClient.getInterfaceName();
        const rtId = await vpnClientEnforcer.getRtId(intf);
        if (!rtId) {
          log.error(`Cannot find rtId of VPN client ${profileId}`);
          return;
        }
        const rtIdHex = Number(rtId).toString(16);
        parameters.push({table: "mangle", chain: "FW_RT_VC_TAG_DEVICE", target: `MARK --set-xmark 0x${rtIdHex}/${routing.MASK_VC}`});
      } else {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        parameters.push({table: "mangle", chain: "FW_RT_REG_TAG_DEVICE", target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`});
      }
      break;
    }
    case "match_group": {
      await ensureCreateRuleGroupChain(targetRgId);
      parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_G_ALLOW" + chainSuffix, target: getRuleGroupChainName(targetRgId, "allow")});
      parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_G_BLOCK" + chainSuffix, target: getRuleGroupChainName(targetRgId, "block")});
      parameters.push({table: "mangle", chain: "FW_QOS_DEV_G", target: getRuleGroupChainName(targetRgId, "qos")});
      parameters.push({table: "mangle", chain: "FW_RT_VC_TAG_DEVICE", target: getRuleGroupChainName(targetRgId, "route")});
      parameters.push({table: "mangle", chain: "FW_RT_REG_TAG_DEVICE", target: getRuleGroupChainName(targetRgId, "route")});
      break;
    }
    case "allow": {
      parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_G_ALLOW" + chainSuffix, target: "FW_ACCEPT"});
      break;
    }
    case "block":
    default: {
      parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_G_BLOCK" + chainSuffix, target: getDropChain(security)});
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

  for (const uid of uids) {
    let localSet4 = null;
    let localSet6 = null;
    switch (identityType) {
      case Constants.NS_VPN_PROFILE: {
        const VPNProfile = require('../net2/VPNProfile.js');
        await VPNProfile.ensureCreateEnforcementEnv(uid);
        localSet4 = VPNProfile.getVPNProfileSetName(uid, 4);
        localSet6 = VPNProfile.getVPNProfileSetName(uid, 6);
        break;
      }
      default:
    }
    if (!localSet4) {
      log.error(`Cannot find localSet of identity type ${identityType} and uid ${uid}`);
      return;
    }
    for (const parameter of parameters) {
      const {table, chain, target} = parameter;
      switch (direction) {
        case "bidirection": {
          // filter rules
          if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
            // need to use different rules for different combination of connection direction and traffic direction
            await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
            await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          } else {
            await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
            await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
          }
          break;
        }
        case "inbound": {
          // inbound filter rules
          await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          break;
        }
        case "outbound": {
          // outbound filter rules
          await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          break;
        }
      }
    }
  }
}

// device-wise rules
async function setupDevicesRules(pid, macAddresses = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG) {
  log.info(`${createOrDestroy} device rule, MAC address ${JSON.stringify(macAddresses)}, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, target rule group UUID ${targetRgId}, rule seq ${seq}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const parameters = [];
  const filterPrio = 1;
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
      break;
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      const qosHandler = await qos.allocateQoSHanderForPolicy(pid);
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
        await qos.deallocateQoSHandlerForPolicy(pid);
      }
      parameters.push({table: "mangle", chain: "FW_QOS_DEV", target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`});
      break;
    }
    case "route": {
      // policy-based routing can only apply to outbound connection
      direction = "outbound";
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        const ovpnClient = new OpenVPNClient({profileId: profileId});
        const intf = ovpnClient.getInterfaceName();
        const rtId = await vpnClientEnforcer.getRtId(intf);
        if (!rtId) {
          log.error(`Cannot find rtId of VPN client ${profileId}`);
          return;
        }
        const rtIdHex = Number(rtId).toString(16);
        parameters.push({table: "mangle", chain: "FW_RT_VC_DEVICE", target: `MARK --set-xmark 0x${rtIdHex}/${routing.MASK_VC}`});
      } else {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        parameters.push({table: "mangle", chain: "FW_RT_REG_DEVICE", target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`});
      }
      break;
    }
    case "match_group": {
      await ensureCreateRuleGroupChain(targetRgId);
      parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_ALLOW" + chainSuffix, target: getRuleGroupChainName(targetRgId, "allow")});
      parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_BLOCK" + chainSuffix, target: getRuleGroupChainName(targetRgId, "block")});
      parameters.push({table: "mangle", chain: "FW_QOS_DEV", target: getRuleGroupChainName(targetRgId, "qos")});
      parameters.push({table: "mangle", chain: "FW_RT_VC_DEVICE", target: getRuleGroupChainName(targetRgId, "route")});
      parameters.push({table: "mangle", chain: "FW_RT_REG_DEVICE", target: getRuleGroupChainName(targetRgId, "route")});
      break;
    }
    case "allow": {
      parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_ALLOW" + chainSuffix, target: "FW_ACCEPT"});
      break;
    }
    case "block":
    default: {
      parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_BLOCK" + chainSuffix, target: getDropChain(security)});
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

  const Host = require('../net2/Host.js');
  for (const mac of macAddresses) {
    await Host.ensureCreateDeviceIpset(mac);
    const localSet = Host.getDeviceSetName(mac);
    for (const parameter of parameters) {
      const {table, chain, target} = parameter;
      switch (direction) {
        case "bidirection": {
          // filter rules
          if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
            // need to use different rules for different combination of connection direction and traffic direction
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          } else {
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
          }
          break;
        }
        case "inbound": {
          // inbound filter rules
          await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          break;
        }
        case "outbound": {
          // outbound filter rules
          await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          break;
        }
      }
    }
  }
}

async function setupTagsRules(pid, uids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG) {
  log.info(`${createOrDestroy} group rule, policy id ${pid}, group uid ${JSON.stringify(uids)}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, target rule group UUID ${targetRgId}, rule seq ${seq}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const parameters = [];
  const filterPrio = 1;
  let chainSuffix = "";
  switch (seq) {
    case Constants.RULE_SEQ_HI:
      chainSuffix = "_HI";
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
        const qosHandler = await qos.allocateQoSHanderForPolicy(pid);
        if (!qosHandler) {
          throw new Error("Reached QoS rule limit");
        }
        const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
        const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
        if (createOrDestroy === "create") {
          await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
          await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, trafficDirection);
          await qos.deallocateQoSHandlerForPolicy(pid);
        }
        parameters.push({table: "mangle", chain: "FW_QOS_DEV_G", target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`, localSet: devSet, localFlagCount: 1});
        parameters.push({table: "mangle", chain: "FW_QOS_NET_G", targert: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`, localSet: netSet, localFlagCount: 2});
        break;
      }
      case "route": {
        // policy-based routing can only apply to outbound connection
        direction = "outbound";
        if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
          const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
          const ovpnClient = new OpenVPNClient({profileId: profileId});
          const intf = ovpnClient.getInterfaceName();
          const rtId = await vpnClientEnforcer.getRtId(intf);
          if (!rtId) {
            log.error(`Cannot find rtId of VPN client ${profileId}`);
            return;
          }
          const rtIdHex = Number(rtId).toString(16);
          parameters.push({table: "mangle", chain: "FW_RT_VC_TAG_DEVICE", target: `MARK --set-xmark 0x${rtIdHex}/${routing.MASK_VC}`, localSet: devSet, localFlagCount: 1});
          parameters.push({table: "mangle", chain: "FW_RT_VC_TAG_NETWORK", target: `MARK --set-xmark 0x${rtIdHex}/${routing.MASK_VC}`, localSet: netSet, localFlagCount: 2});
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({table: "mangle", chain: "FW_RT_REG_TAG_DEVICE", target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`, localSet: devSet, localFlagCount: 1});
          parameters.push({table: "mangle", chain: "FW_RT_REG_TAG_NETWORK", target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`, localSet: netSet, localFlagCount: 2});
        }
        break;
      }
      case "match_group": {
        await ensureCreateRuleGroupChain(targetRgId);
        parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_G_ALLOW" + chainSuffix, target: getRuleGroupChainName(targetRgId, "allow"), localSet: devSet, localFlagCount: 1});
        parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_G_BLOCK" + chainSuffix, target: getRuleGroupChainName(targetRgId, "block"), localSet: devSet, localFlagCount: 1});
        parameters.push({table: "filter", chain: "FW_FIREWALL_NET_G_ALLOW" + chainSuffix, target: getRuleGroupChainName(targetRgId, "allow"), localSet: netSet, localFlagCount: 2});
        parameters.push({table: "filter", chain: "FW_FIREWALL_NET_G_BLOCK" + chainSuffix, target: getRuleGroupChainName(targetRgId, "block"), localSet: netSet, localFlagCount: 2});
        parameters.push({table: "mangle", chain: "FW_QOS_DEV_G", target: getRuleGroupChainName(targetRgId, "qos"), localSet: devSet, localFlagCount: 1});
        parameters.push({table: "mangle", chain: "FW_QOS_NET_G", target: getRuleGroupChainName(targetRgId, "qos"), localSet: netSet, localFlagCount: 2});
        parameters.push({table: "mangle", chain: "FW_RT_VC_TAG_DEVICE", target: getRuleGroupChainName(targetRgId, "route"), localSet: devSet, localFlagCount: 1});
        parameters.push({table: "mangle", chain: "FW_RT_VC_TAG_NETWORK", target: getRuleGroupChainName(targetRgId, "route"), localSet: netSet, localFlagCount: 2});
        parameters.push({table: "mangle", chain: "FW_RT_REG_TAG_DEVICE", target: getRuleGroupChainName(targetRgId, "route"), localSet: devSet, localFlagCount: 1});
        parameters.push({table: "mangle", chain: "FW_RT_REG_TAG_NETWORK", target: getRuleGroupChainName(targetRgId, "route"), localSet: netSet, localFlagCount: 2});
        break;
      }
      case "allow": {
        parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_G_ALLOW" + chainSuffix, target: "FW_ACCEPT", localSet: devSet, localFlagCount: 1});
        parameters.push({table: "filter", chain: "FW_FIREWALL_NET_G_ALLOW" + chainSuffix, target: "FW_ACCEPT", localSet: netSet, localFlagCount: 2});
        break;
      }
      case "block":
      default: {
        parameters.push({table: "filter", chain: "FW_FIREWALL_DEV_G_BLOCK" + chainSuffix, target: getDropChain(security), localSet: devSet, localFlagCount: 1});
        parameters.push({table: "filter", chain: "FW_FIREWALL_NET_G_BLOCK" + chainSuffix, target: getDropChain(security), localSet: netSet, localFlagCount: 2});
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


  for (const parameter of parameters) {
    const {table, chain, target, localSet, localFlagCount} = parameter;
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
        } else {
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
        }
        break;
      }
      case "inbound": {
        // filter rules
        await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        break;
      }
      case "outbound": {
        // filter rules
        await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate), transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null;
        await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        break;
      }
    }
  }
}

async function setupIntfsRules(pid, uuids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG) {
  log.info(`${createOrDestroy} network rule, policy id ${pid}, uuid ${JSON.stringify(uuids)}, local port ${localPortSet}, remote set ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, target rule group UUID ${targetRgId}, rule seq ${seq}`);
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
    case Constants.RULE_SEQ_REG:
    default:
      chainSuffix = "";
  }
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      const qosHandler = await qos.allocateQoSHanderForPolicy(pid);
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
        await qos.deallocateQoSHandlerForPolicy(pid);
      }
      parameters.push({table: "mangle", chain: "FW_QOS_NET", target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`});
      break;
    }
    case "route": {
      // policy-based routing can only apply to outbound connection
      direction = "outbound";
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        const ovpnClient = new OpenVPNClient({profileId: profileId});
        const intf = ovpnClient.getInterfaceName();
        const rtId = await vpnClientEnforcer.getRtId(intf);
        if (!rtId) {
          log.error(`Cannot find rtId of VPN client ${profileId}`);
          return;
        }
        const rtIdHex = Number(rtId).toString(16);
        parameters.push({table: "mangle", chain: "FW_RT_VC_NETWORK", target: `MARK --set-xmark 0x${rtIdHex}/${routing.MASK_VC}`});
      } else {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        parameters.push({table: "mangle", chain: "FW_RT_REG_NETWORK", target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`});
      }
      break;
    }
    case "match_group": {
      await ensureCreateRuleGroupChain(targetRgId);
      parameters.push({table: "filter", chain: "FW_FIREWALL_NET_ALLOW" + chainSuffix, target: getRuleGroupChainName(targetRgId, "allow")});
      parameters.push({table: "filter", chain: "FW_FIREWALL_NET_BLOCK" + chainSuffix, target: getRuleGroupChainName(targetRgId, "block")});
      parameters.push({table: "mangle", chain: "FW_QOS_NET", target: getRuleGroupChainName(targetRgId, "qos")});
      parameters.push({table: "mangle", chain: "FW_RT_VC_NETWORK", target: getRuleGroupChainName(targetRgId, "route")});
      parameters.push({table: "mangle", chain: "FW_RT_REG_NETWORK", target: getRuleGroupChainName(targetRgId, "route")});
      break;
    }
    case "allow": {
      parameters.push({table: "filter", chain: "FW_FIREWALL_NET_ALLOW" + chainSuffix, target: "FW_ACCEPT"});
      break;
    }
    case "block":
    default: {
      parameters.push({table: "filter", chain: "FW_FIREWALL_NET_BLOCK" + chainSuffix, target: getDropChain(security)});
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

  const NetworkProfile = require('../net2/NetworkProfile.js');
  for (const uuid of uuids) {
    await NetworkProfile.ensureCreateEnforcementEnv(uuid);
    const localSet4 = NetworkProfile.getNetIpsetName(uuid, 4);
    const localSet6 = NetworkProfile.getNetIpsetName(uuid, 6);
    for (const parameter of parameters) {
      const {table, chain, target} = parameter;
      switch (direction) {
        case "bidirection": {
          // filter rules
          if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
            // need to use different rules for different combination of connection direction and traffic direction
            await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
            await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          } else {
            await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
            await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
          }
          break;
        }
        case "inbound": {
          // inbound filter rules
          await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
          break;
        }
        case "outbound": {
          // outbound filter rules
          await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
          break;
        }
      }
    }
  }
}

async function setupRuleGroupRules(pid, ruleGroupUUID, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security) {
  log.info(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, parent rule group UUID ${ruleGroupUUID}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  const filterPrio = 1;
  const parameters = [];
  await ensureCreateRuleGroupChain(ruleGroupUUID);
  switch (action) {
    case "qos": {
      qdisc = qdisc || "fq_codel";
      const qosHandler = await qos.allocateQoSHanderForPolicy(pid);
      if (!qosHandler) {
        throw new Error("Reached QoS rule limit");
      }
      const fwmark = Number(qosHandler) << (trafficDirection === "upload" ? 23 : 16); // 23-29 bit is reserved for upload mark filter, 16-22 bit is reserved for download mark filter
      const fwmask = trafficDirection === "upload" ? qos.QOS_UPLOAD_MASK : qos.QOS_DOWNLOAD_MASK;
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
        await qos.deallocateQoSHandlerForPolicy(pid);
      }
      parameters.push({table: "mangle", chain: getRuleGroupChainName(ruleGroupUUID, "qos"), target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`});
      break;
    }
    case "route": {
      // TODO: support route in rule group member rules
      direction = "outbound";
      if (wanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
        const profileId = wanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
        const ovpnClient = new OpenVPNClient({profileId: profileId});
        const intf = ovpnClient.getInterfaceName();
        const rtId = await vpnClientEnforcer.getRtId(intf);
        if (!rtId) {
          log.error(`Cannot find rtId of VPN client ${profileId}`);
          return;
        }
        const rtIdHex = Number(rtId).toString(16);
        parameters.push({table: "mangle", chain: getRuleGroupChainName(ruleGroupUUID, "route"), target: `MARK --set-xmark 0x${rtIdHex}/${routing.MASK_VC}`});
      } else {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        parameters.push({table: "mangle", chain: getRuleGroupChainName(ruleGroupUUID, "route"), target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`})
      }
      break;
    }
    case "allow": {
      parameters.push({table: "filter", chain: getRuleGroupChainName(ruleGroupUUID, "allow"), target: "FW_ACCEPT"});
      break;
    }
    case "block":
    default: {
      parameters.push({table: "filter", chain: getRuleGroupChainName(ruleGroupUUID, "block"), target: getDropChain(security)});
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

  for (const parameter of parameters) {
    const {table, chain, target} = parameter;
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          // need to use different rules for different combination of connection direction and traffic direction
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
        } else {
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate);
        }
        break;
      }
      case "inbound": {
        // inbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        break;
      }
      case "outbound": {
        // outbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        break;
      }
      default:
    }
  }
}

async function manipulateFiveTupleRule(action, srcMatchingSet, srcSpec, srcPositive = true, srcPortSet, dstMatchingSet, dstSpec, dstPositive = true, dstPortSet, proto, ctDir, target, chain, table, af = 4, comment, ctstate, transferredBytes, transferredPackets, avgPacketBytes, transferDirection) {
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
  if (transferDirection) {
    if (transferredBytes)
      rule.mdl("connbytes", `--connbytes ${transferredBytes} --connbytes-dir ${transferDirection} --connbytes-mode bytes`);
    if (transferredPackets)
      rule.mdl("connbytes", `--connbytes ${transferredPackets} --connbytes-dir ${transferDirection} --connbytes-mode packets`);
    if (avgPacketBytes)
      rule.mdl("connbytes", `--connbytes ${avgPacketBytes} --connbytes-dir ${transferDirection} --connbytes-mode avgpkt`);
  }
  rule.jmp(target);
  await exec(rule.toCmd(action));
}


module.exports = {
  setupBlockChain,
  batchBlock,
  batchUnblock,
  block,
  unblock,
  setupCategoryEnv,
  setupGlobalRules,
  setupDevicesRules,
  setupGenericIdentitiesRules,
  getDstSet,
  getDstSet6,
  getMacSet,
  existsBlockingEnv,
  setupTagsRules,
  setupIntfsRules,
  setupRuleGroupRules,
  manipulateFiveTupleRule,
  VPN_CLIENT_WAN_PREFIX
}
