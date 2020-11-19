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

const { Rule } = require('../net2/Iptables.js');
const qos = require('./QoS.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();

const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');
const VPN_CLIENT_WAN_PREFIX = "VC:";

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

async function setupGlobalRules(pid, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID) {
  log.info(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  let table = null;
  let chain = null;
  let target = null;
  const filterPrio = 1;
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
      table = "mangle";
      chain = "FW_QOS_GLOBAL"
      target = `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`;
      break;
    }
    case "route": {
      table = "mangle";
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
        chain = "FW_RT_VC_GLOBAL";
        target = `MARK --set-xmark 0x${rtIdHex}/0xffff`;
      } else {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        chain = "FW_RT_REG_GLOBAL";
        target = `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`;
      }
      break;
    }
    case "allow": {
      table = "filter";
      chain = "FW_FIREWALL_GLOBAL_ALLOW";
      target = "FW_ACCEPT";
      break;
    }
    case "block":
    default: {
      table = "filter";
      chain = "FW_FIREWALL_GLOBAL_BLOCK";
      target = "FW_DROP";
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

// device-wise rules
async function setupDevicesRules(pid, macAddresses = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID) {
  log.info(`${createOrDestroy} device rule, MAC address ${JSON.stringify(macAddresses)}, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  let table = null;
  let chain = null;
  let target = null;
  const filterPrio = 1;
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
      table = "mangle";
      chain = "FW_QOS_DEV"
      target = `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`;
      break;
    }
    case "route": {
      table = "mangle";
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
        chain = "FW_RT_VC_DEVICE";
        target = `MARK --set-xmark 0x${rtIdHex}/0xffff`;
      } else {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        chain = "FW_RT_REG_DEVICE";
        target = `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`;
      }
      break;
    }
    case "allow": {
      table = "filter";
      chain = "FW_FIREWALL_DEV_ALLOW";
      target = "FW_ACCEPT";
      break;
    }
    case "block":
    default: {
      table = "filter";
      chain = "FW_FIREWALL_DEV_BLOCK";
      target = "FW_DROP";
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

async function setupTagsRules(pid, uids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID) {
  log.info(`${createOrDestroy} group rule, policy id ${pid}, group uid ${JSON.stringify(uids)}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}`);
  const op = createOrDestroy === "create" ? "-A" : "-D";
  let table = null;
  let devChain = null;
  let netChain = null;
  let target = null;
  const filterPrio = 1;
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
      table = "mangle";
      devChain = "FW_QOS_DEV_G";
      netChain = "FW_QOS_NET_G";
      target = `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`;
      break;
    }
    case "route": {
      table = "mangle";
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
        devChain = "FW_RT_VC_TAG_DEVICE";
        netChain = "FW_RT_VC_TAG_NETWORK";
        target = `MARK --set-xmark 0x${rtIdHex}/0xffff`;
      } else {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        devChain = "FW_RT_REG_TAG_DEVICE";
        netChain = "FW_RT_REG_TAG_NETWORK";
        target = `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`;
      }
      break;
    }
    case "allow": {
      table = "filter";
      devChain = "FW_FIREWALL_DEV_G_ALLOW";
      netChain = "FW_FIREWALL_NET_G_ALLOW";
      target = "FW_ACCEPT";
      break;
    }
    case "block":
    default: {
      table = "filter";
      devChain = "FW_FIREWALL_DEV_G_BLOCK";
      netChain = "FW_FIREWALL_NET_G_BLOCK"
      target = "FW_DROP";
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

  const Tag = require('../net2/Tag.js');
  for (const uid of uids) {
    await Tag.ensureCreateEnforcementEnv(uid);
    const devSet = Tag.getTagDeviceSetName(uid);
    const netSet = Tag.getTagNetSetName(uid);
    switch (direction) {
      case "bidirection": {
        // filter rules
        if (trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)) {
          await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, devChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "ORIGINAL", target, devChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, devChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "REPLY", target, devChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, devChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "ORIGINAL", target, devChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, devChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "REPLY", target, devChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");

          await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "REPLY", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, netChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, netChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "reply" : "original");
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "REPLY", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection === "upload" ? "original" : "reply");
        } else {
          await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, devChain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, null, target, devChain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, devChain, table, 6, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, null, target, devChain, table, 6, `rule_${pid}`, ctstate);

          await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, netChain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, null, target, netChain, table, 4, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, null, target, netChain, table, 6, `rule_${pid}`, ctstate);
          await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, null, target, netChain, table, 6, `rule_${pid}`, ctstate);
        }
        break;
      }
      case "inbound": {
        // filter rules
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, devChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "ORIGINAL", target, devChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, devChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "ORIGINAL", target, devChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);

        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "REPLY", target, netChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "ORIGINAL", target, netChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "reply" : "original") : null);
        break;
      }
      case "outbound": {
        // filter rules
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, devChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "REPLY", target, devChain, table, 4, `rule_${pid}`, ctstate), transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null;
        await this.manipulateFiveTupleRule(op, devSet, "src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, devChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, devSet, "dst", true, localPortSet, proto, "REPLY", target, devChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);

        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet4, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet4, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "REPLY", target, netChain, table, 4, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, netSet, "src,src", true, localPortSet, remoteSet6, remoteDstSpec, remotePositive, remotePortSet, proto, "ORIGINAL", target, netChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        await this.manipulateFiveTupleRule(op, remoteSet6, remoteSrcSpec, remotePositive, remotePortSet, netSet, "dst,dst", true, localPortSet, proto, "REPLY", target, netChain, table, 6, `rule_${pid}`, ctstate, transferredBytes, transferredPackets, avgPacketBytes, trafficDirection ? (trafficDirection === "upload" ? "original" : "reply") : null);
        break;
      }
    }
  }
}

async function setupIntfsRules(pid, uuids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto, action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null, trafficDirection, ratelimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes, wanUUID) {
  log.info(`${createOrDestroy} network rule, policy id ${pid}, uuid ${JSON.stringify(uuids)}, local port ${localPortSet}, remote set ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${ratelimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}`);
  if (_.isEmpty(uuids))
    return;
  const op = createOrDestroy === "create" ? "-A" : "-D";
  let table = null;
  let chain = null;
  let target = null;
  const filterPrio = 1;
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
      table = "mangle";
      chain = "FW_QOS_NET"
      target = `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`;
      break;
    }
    case "route": {
      table = "mangle";
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
        chain = "FW_RT_VC_NETWORK";
        target = `MARK --set-xmark 0x${rtIdHex}/0xffff`;
      } else {
        const NetworkProfile = require('../net2/NetworkProfile.js');
        await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
        chain = "FW_RT_REG_NETWORK";
        target = `SET --map-set ${NetworkProfile.getRouteIpsetName(wanUUID)} dst,dst --map-mark`;
      }
      break;
    }
    case "allow": {
      table = "filter";
      chain = "FW_FIREWALL_NET_ALLOW";
      target = "FW_ACCEPT";
      break;
    }
    case "block":
    default: {
      table = "filter";
      chain = "FW_FIREWALL_NET_BLOCK";
      target = "FW_DROP";
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
  setupBlockChain:setupBlockChain,
  batchBlock: batchBlock,
  batchUnblock: batchUnblock,
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
  manipulateFiveTupleRule: manipulateFiveTupleRule,
  VPN_CLIENT_WAN_PREFIX: VPN_CLIENT_WAN_PREFIX
}
