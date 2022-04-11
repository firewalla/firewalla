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

const VPNClient = require('../extension/vpnclient/VPNClient.js');
const VPN_CLIENT_WAN_PREFIX = "VC:";
const VIRT_WAN_GROUP_PREFIX = "VWG:";
const UPNP_ACCEPT_CHAIN = "FR_UPNP_ACCEPT";

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
    case "alarm":
      return `FW_RG_${uuid.substring(0, 13)}_ALARM`;
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

async function setupCategoryEnv(category, dstType = "hash:ip", hashSize = 128) {
  if (!category) {
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
    if (output.stdout == 4) {
      return true
    } else {
      return false
    }
  } catch (err) {
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

async function setupGlobalRules(pid, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp) {
  log.info(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}`);
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
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
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
        parameters.push({ table: "mangle", chain: `FW_RT_GLOBAL_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
        parameters.push({ table: "mangle", chain: `FW_RT_GLOBAL_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `FW_RT_GLOBAL_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_GLOBAL_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `FW_RT_GLOBAL_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_GLOBAL_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
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
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: "FW_ALARM_GLOBAL", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
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

  for (const parameter of parameters) {
    const { table, chain, target } = parameter;
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          // need to use different rules for different combination of connection direction and traffic direction
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
        } else {
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
        }
        break;
      }
      case "inbound": {
        // inbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        break;
      }
      case "outbound": {
        // outbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        break;
      }
      default:
    }
  }
}

async function setupGenericIdentitiesRules(pid, guids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp) {
  log.info(`${createOrDestroy} generic identity rule, guids ${JSON.stringify(guids)}, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}`);
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
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
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
        parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
        parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
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
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: "FW_ALARM_DEV", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
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
      const { table, chain, target } = parameter;
      switch (direction) {
        case "bidirection": {
          // filter rules
          if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
            // need to use different rules for different combination of connection direction and traffic direction
            await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          } else {
            await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          }
          break;
        }
        case "inbound": {
          // inbound filter rules
          await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          break;
        }
        case "outbound": {
          // outbound filter rules
          await this.manipulateFiveTupleRule(op, localSet4, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet6, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          break;
        }
      }
    }
  }
}

// device-wise rules
async function setupDevicesRules(pid, macAddresses = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp) {
  log.info(`${createOrDestroy} device rule, MAC address ${JSON.stringify(macAddresses)}, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}`);
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
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
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
        parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
        parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_DEVICE_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
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
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: "FW_ALARM_DEV", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
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

  const Host = require('../net2/Host.js');
  for (const mac of macAddresses) {
    await Host.ensureCreateDeviceIpset(mac);
    const localSet = Host.getDeviceSetName(mac);
    for (const parameter of parameters) {
      const { table, chain, target } = parameter;
      switch (direction) {
        case "bidirection": {
          // filter rules
          if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
            // need to use different rules for different combination of connection direction and traffic direction
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          } else {
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          }
          break;
        }
        case "inbound": {
          // inbound filter rules
          await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          break;
        }
        case "outbound": {
          // outbound filter rules
          await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, "dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          break;
        }
      }
    }
  }
}

async function setupTagsRules(pid, uids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp) {
  log.info(`${createOrDestroy} group rule, policy id ${pid}, group uid ${JSON.stringify(uids)}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}`);
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
        if (createOrDestroy === "create") {
          await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
          await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, trafficDirection);
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
          parameters.push({ table: "mangle", chain: `FW_RT_TAG_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_TAG_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_TAG_DEVICE_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark`, localSet: devSet, localFlagCount: 1 });
          parameters.push({ table: "mangle", chain: `FW_RT_TAG_NETWORK_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark`, localSet: netSet, localFlagCount: 2 });
        } else {
          if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
            const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
            const VirtWanGroup = require('../net2/VirtWanGroup.js');
            await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
            parameters.push({ table: "mangle", chain: `FW_RT_TAG_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
            parameters.push({ table: "mangle", chain: `FW_RT_TAG_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
            parameters.push({ table: "mangle", chain: `FW_RT_TAG_DEVICE_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark`, localSet: devSet, localFlagCount: 1 });
            parameters.push({ table: "mangle", chain: `FW_RT_TAG_NETWORK_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark`, localSet: netSet, localFlagCount: 2 });
          } else {
            const NetworkProfile = require('../net2/NetworkProfile.js');
            await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
            parameters.push({ table: "mangle", chain: `FW_RT_TAG_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
            parameters.push({ table: "mangle", chain: `FW_RT_TAG_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
            parameters.push({ table: "mangle", chain: `FW_RT_TAG_DEVICE_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark`, localSet: devSet, localFlagCount: 1 });
            parameters.push({ table: "mangle", chain: `FW_RT_TAG_NETWORK_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark`, localSet: netSet, localFlagCount: 2 });
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


  for (const parameter of parameters) {
    const { table, chain, target, localSet, localFlagCount } = parameter;
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
        } else {
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
        }
        break;
      }
      case "inbound": {
        // filter rules
        await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        break;
      }
      case "outbound": {
        // filter rules
        await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, localSet, Array(localFlagCount).fill("src").join(","), true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, Array(localFlagCount).fill("dst").join(","), true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        break;
      }
    }
  }
}

async function setupIntfsRules(pid, uuids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp) {
  log.info(`${createOrDestroy} network rule, policy id ${pid}, uuid ${JSON.stringify(uuids)}, local port ${localPortSet}, remote set ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}`);
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
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
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
        parameters.push({ table: "mangle", chain: `FW_RT_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
        parameters.push({ table: "mangle", chain: `FW_RT_NETWORK_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `FW_RT_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_NETWORK_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `FW_RT_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `FW_RT_NETWORK_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
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
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: "FW_ALARM_NET", target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
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

  const NetworkProfile = require('../net2/NetworkProfile.js');
  for (const uuid of uuids) {
    await NetworkProfile.ensureCreateEnforcementEnv(uuid);
    const localSet4 = NetworkProfile.getNetIpsetName(uuid, 4);
    const localSet6 = NetworkProfile.getNetIpsetName(uuid, 6);
    for (const parameter of parameters) {
      const { table, chain, target } = parameter;
      switch (direction) {
        case "bidirection": {
          // filter rules
          if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
            // need to use different rules for different combination of connection direction and traffic direction
            await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          } else {
            await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
            await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          }
          break;
        }
        case "inbound": {
          // inbound filter rules
          await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
          break;
        }
        case "outbound": {
          // outbound filter rules
          await this.manipulateFiveTupleRule(op, localSet4, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet4, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet6, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet6, "dst,dst", true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
          break;
        }
      }
    }
  }
}

async function setupRuleGroupRules(pid, ruleGroupUUID, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID, security, reverse1, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost, subPrio, routeType, qosHandler, upnp) {
  log.info(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, parent rule group UUID ${ruleGroupUUID}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}`);
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
      if (createOrDestroy === "create") {
        await qos.createQoSClass(qosHandler, trafficDirection, ratelimit, priority, qdisc);
        await qos.createTCFilter(qosHandler, qosHandler, trafficDirection, filterPrio, fwmark);
      } else {
        await qos.destroyTCFilter(qosHandler, trafficDirection, filterPrio, fwmark);
        await qos.destroyQoSClass(qosHandler, trafficDirection);
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
        parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "route")}_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
        parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "route")}_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "route")}_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "route")}_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "route")}_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R D=O CD=O M=${pid} "` });
          parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, "route")}_${subPrio}`, target: `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID, hardRoute)} dst,dst --map-mark` });
        }
      }
      break;
    }
    case "alarm": {
      parameters.push({ table: "filter", chain: getRuleGroupChainName(ruleGroupUUID, "alarm"), target: `LOG --log-prefix "[FW_ALM]PID=${pid} "` });
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

  for (const parameter of parameters) {
    const { table, chain, target } = parameter;
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          // need to use different rules for different combination of connection direction and traffic direction
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original", tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply", tlsHostSet, tlsHost);
        } else {
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, 4, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, null, target, chain, table, 6, `rule_${pid}`, ctstate, undefined, undefined, undefined, undefined, tlsHostSet, tlsHost);
        }
        break;
      }
      case "inbound": {
        // inbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null, tlsHostSet, tlsHost);
        break;
      }
      case "outbound": {
        // outbound filter rules
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, localSet, localSrcSpec, true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, localSet, localDstSpec, true, localPortSet, proto, "REPLY", target, chain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null, tlsHostSet, tlsHost);
        break;
      }
      default:
    }
  }
}

async function manipulateFiveTupleRule(action, srcMatchingSet, srcSpec, srcPositive = true, srcPortSet, dstMatchingSet, dstSpec, dstPositive = true, dstPortSet, proto, ctDir, target, chain, table, af = 4, comment, ctstate, transferredBytes, transferredPackets, avgPacketBytes, transferDirection, tlsHostSet, tlsHost) {
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
  if (tlsHostSet) {
    rule.mdl("tls", `--tls-hostset ${tlsHostSet}`)
  }
  if (tlsHost) {
    rule.mdl("tls", `--tls-host ${tlsHost}`)
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
