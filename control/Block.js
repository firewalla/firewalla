/*    Copyright 2016-2026 Firewalla Inc.
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
const iptc = require('./IptablesControl.js');
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
  const cmds4 = [
    new Rule('filter').chn(getRuleGroupChainName(uuid, "allow")),
    new Rule('filter').chn(getRuleGroupChainName(uuid, "block")),
    new Rule('filter').chn(getRuleGroupChainName(uuid, "allow") + "_HI"),
    new Rule('filter').chn(getRuleGroupChainName(uuid, "block") + "_HI"),
    new Rule('filter').chn(getRuleGroupChainName(uuid, "allow") + "_LO"),
    new Rule('filter').chn(getRuleGroupChainName(uuid, "block") + "_LO"),
    new Rule('filter').chn(getRuleGroupChainName(uuid, "alarm")),
  ];
  for (let i = 1; i <= 5; i++) {
    cmds4.push(new Rule('mangle').chn(getRuleGroupChainName(uuid, "qos") + "_" + i));
    cmds4.push(new Rule('mangle').chn(getRuleGroupChainName(uuid, "route") + "_" + i));
    cmds4.push(new Rule('mangle').chn(getRuleGroupChainName(uuid, "soft_route") + "_" + i));
    cmds4.push(new Rule('nat').chn(getRuleGroupChainName(uuid, "snat") + "_" + i));
  }

  const cmds6 = []
  for (const cmd of cmds4) {
    cmds6.push(cmd.clone().fam(6))
  }

  // queue chain creation using action '-N'
  for (const r of [...cmds4, ...cmds6]) {
    iptc.addRule(r.opr('-N'));
  }

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
    setupCategoryEnv("default_c", "hash:net", 4096),
  ])

  log.info("Finished setup for traffic blocking");
}

function getMacSet(tag) {
  return `c_bm_${tag}_set`
}

function getDstSet(tag, ip6 = false) {
  if (!ip6)
    return `c_bd_${tag}_set`
  else
    return `c_bd_${tag}_set6`
}

function getTLSHostSet(tag) {
  return `c_bd_${tag}_tls_hostset`
}

function getConnSet(tag, ip6 = false) {
  if (!ip6)
    return `c_bc_${tag}_set`
  else
    return `c_bc_${tag}_set6`
}

function getConnSet6(tag) {
  return `c_bc_${tag}_set6`
}

function getPredefinedConnSet(security, direction, ip6=false) {
  let dirc = ""
  if (direction === "inbound") dirc = "ib_"
  else if (direction === "outbound") dirc = "ob_"
  
  const connSet = (security ? 'sec_' : '') + 'block_' + dirc + 'conn_set' + (ip6 ? '6' : '');
  return connSet;
}

function getPredefinedConnSet6(security, direction) {
  return getPredefinedConnSet(security, direction, true);
}

function getDstSet6(tag) {
  return `c_bd_${tag}_set6`
}

function getDropChain(security, tls) {
  return `FW_${security ? "SEC_" : ""}${tls ? "TLS_" : ""}DROP`;
}

async function setupCategoryEnv(category, dstType = "hash:ip", hashsize = 128, comment = false, isCountry = false) {
  if (!category) {
    return;
  }

  const CategoryUpdater = require('./CategoryUpdater.js');
  const categoryUpdater = new CategoryUpdater();

  const ipset4 = categoryUpdater.getIPSetName(category);
  const tempIpset = categoryUpdater.getTempIPSetName(category);
  const ipset6 = categoryUpdater.getIPSetNameForIPV6(category);
  const tempIpset6 = categoryUpdater.getTempIPSetNameForIPV6(category);

  Ipset.create(ipset4, dstType, false, { hashsize, maxelem: 65536, comment });
  Ipset.create(ipset6, dstType, true, { hashsize, maxelem: 65536, comment });
  Ipset.create(tempIpset, dstType, false, { hashsize, maxelem: 65536, comment });
  Ipset.create(tempIpset6, dstType, true, { hashsize, maxelem: 65536, comment });

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

    const connIpset = categoryUpdater.getConnectionIPSetName(category);
    const connIpset6 = categoryUpdater.getConnectionIPSetNameForIPV6(category);

    const aggrIpset = categoryUpdater.getAggrIPSetName(category);
    const aggrIpset6 = categoryUpdater.getAggrIPSetNameForIPV6(category);
    const staticAggrIpset = categoryUpdater.getAggrIPSetName(category, true);
    const staticAggrIpset6 = categoryUpdater.getAggrIPSetNameForIPV6(category, true);
    const allowIpset = categoryUpdater.getAllowIPSetName(category);
    const allowIpset6 = categoryUpdater.getAllowIPSetNameForIPV6(category);

    Ipset.create(netPortIpset, 'hash:net,port', false, { hashsize, maxelem: 65536, comment });
    Ipset.create(netPortIpset6, 'hash:net,port', true, { hashsize, maxelem: 65536, comment });
    Ipset.create(tempNetPortIpset, 'hash:net,port', false, { hashsize, maxelem: 65536, comment });
    Ipset.create(tempNetPortIpset6, 'hash:net,port', true, { hashsize, maxelem: 65536, comment });
    Ipset.create(domainPortIpset, 'hash:net,port', false, { hashsize, maxelem: 65536, comment });
    Ipset.create(domainPortIpset6, 'hash:net,port', true, { hashsize, maxelem: 65536, comment });
    Ipset.create(tempDomainPortIpset, 'hash:net,port', false, { hashsize, maxelem: 65536, comment });
    Ipset.create(tempDomainPortIpset6, 'hash:net,port', true, { hashsize, maxelem: 65536, comment });
    Ipset.create(aggrIpset, 'list:set');
    Ipset.create(aggrIpset6, 'list:set');


    Ipset.create(staticIpset, dstType, false, { hashsize, maxelem: 65536, comment });
    Ipset.create(staticIpset6, dstType, true, { hashsize, maxelem: 65536, comment });
    Ipset.create(tempStaticIpset, dstType, false, { hashsize, maxelem: 65536, comment });
    Ipset.create(tempStaticIpset6, dstType, true, { hashsize, maxelem: 65536, comment });
    Ipset.create(staticDomainPortIpset, 'hash:net,port', false, { hashsize, maxelem: 65536, comment });
    Ipset.create(staticDomainPortIpset6, 'hash:net,port', true, { hashsize, maxelem: 65536, comment });
    Ipset.create(tempStaticDomainPortIpset, 'hash:net,port', false, { hashsize, maxelem: 65536, comment });
    Ipset.create(tempStaticDomainPortIpset6, 'hash:net,port', true, { hashsize, maxelem: 65536, comment });

    Ipset.create(connIpset, 'hash:ip,port,ip', false, { hashsize, maxelem: 65536, comment, timeout: 300 });
    Ipset.create(connIpset6, 'hash:ip,port,ip', true, { hashsize, maxelem: 65536, comment, timeout: 300 });

    Ipset.create(staticAggrIpset, 'list:set');
    Ipset.create(staticAggrIpset6, 'list:set');
  
    Ipset.create(allowIpset, 'list:set');
    Ipset.create(allowIpset6, 'list:set');
  
    // add both dynamic and static ipset to category default ipset
    Ipset.add(aggrIpset, ipset4);
    Ipset.add(aggrIpset, staticIpset);
    Ipset.add(aggrIpset, netPortIpset);
    Ipset.add(aggrIpset, staticDomainPortIpset);
    Ipset.add(aggrIpset6, ipset6);
    Ipset.add(aggrIpset6, staticIpset6);
    Ipset.add(aggrIpset6, netPortIpset6);
    Ipset.add(aggrIpset6, staticDomainPortIpset6);
  
    Ipset.add(staticAggrIpset, staticIpset); // only add static ipset to category static ipset
    Ipset.add(staticAggrIpset, netPortIpset);
    Ipset.add(staticAggrIpset, staticDomainPortIpset);
    Ipset.add(staticAggrIpset6, staticIpset6);
    Ipset.add(staticAggrIpset6, netPortIpset6);
    Ipset.add(staticAggrIpset6, staticDomainPortIpset6);
  
    Ipset.add(allowIpset, ipset4);
    Ipset.add(allowIpset, staticIpset);
    Ipset.add(allowIpset6, ipset6);
    Ipset.add(allowIpset6, staticIpset6);
    Ipset.add(allowIpset, netPortIpset);
    Ipset.add(allowIpset6, netPortIpset6);
    Ipset.add(allowIpset, domainPortIpset);
    Ipset.add(allowIpset, staticDomainPortIpset);
    Ipset.add(allowIpset6, domainPortIpset6);
    Ipset.add(allowIpset6, staticDomainPortIpset6);
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

async function batchActionNetPort(elements, portObj, ipset, op='add', options = {}) {
  log.debug("Batch block net port of", ipset);
  if (!_.isArray(elements) || elements.length === 0)
    return;
  const v4Set = ipset;
  const v6Set = ipset + '6';
  const gateway6 = sysManager.myDefaultGateway6();
  const gateway = sysManager.myDefaultGateway();

  for (const element of elements) {
    const ipSpliterIndex = element.search(/[/,]/)
    const ipAddr = ipSpliterIndex > 0 ? element.substring(0, ipSpliterIndex) : element;

    //Prevent gateway IP from being added into blocking IP set dynamically
    if (gateway == ipAddr || gateway6 == ipAddr) {
      continue;
    }
    let setName
    if (new Address4(ipAddr).isValid()) {
      setName = v4Set;
    } else {
      const ip6 = new Address6(ipAddr);
      if (ip6.isValid() && ip6.correctForm() != '::') {
        setName = v6Set;
      }
    }
    if (!setName) continue;

    if (op === 'add') {
      Ipset.add(setName, `${ipAddr},${CategoryEntry.toPortStr(portObj)}`, { comment: options.comment });
    } else {
      Ipset.del(setName, `${ipAddr},${CategoryEntry.toPortStr(portObj)}`);
    }
  }
}

// this is used only for user defined target list so there is no need to remove from ipset. The ipset will be reset upon category reload or update.
async function batchBlockNetPort(elements, portObj, ipset, options = {}) {
  return batchActionNetPort(elements, portObj, ipset, 'add', options);
}

async function batchUnblockNetPort(elements, portObj, ipset, options = {}) {
  return batchActionNetPort(elements, portObj, ipset, 'del', options);
}

function isGatewayOrPublicIp(ip) {
  const gateway6 = sysManager.myDefaultGateway6();
  const gateway = sysManager.myDefaultGateway();
  const publicIps = sysManager.getPublicIPs();

  if (ip === gateway || ip === gateway6) {
    return true;
  }

  if (publicIps && _.isObject(publicIps)) {
    for (const [_intf, publicIp] of Object.entries(publicIps)) {
      if (ip === publicIp) {
        return true;
      }
    }
  }

  return false;
}


// no need to remove from ipset, record will be cleared when timeout
function batchBlockConnection(elements, ipset, options = {}) {
  log.debug("Batch block connection of", ipset);
  if (!_.isArray(elements) || elements.length === 0)
    return;
  const v4Set = ipset;
  const v6Set = ipset + '6';
  for (const element of elements) {
    let {localAddr, localPorts, remoteAddr, protocol} = element;
    if (!localAddr || !localPorts || !remoteAddr || !protocol) {
      continue;
    }

    if (!_.isArray(localPorts)) {
      localPorts = [localPorts];
    }

    //Prevent gateway IP and publicIp from being added into blocking IP set dynamically
    if (isGatewayOrPublicIp(remoteAddr)) {
      continue;
    } 
    let setName;
    if (new Address4(remoteAddr).isValid() && new Address4(localAddr).isValid()) {
      setName = v4Set;
    } else {
      const local6 = new Address6(localAddr);
      const remote6 = new Address6(remoteAddr);
      if (local6.isValid() && local6.correctForm() != '::' && remote6.isValid() && remote6.correctForm() != '::') {
        setName = v6Set;
      } else {
        log.debug("invalid local address or remote address", localAddr, remoteAddr);
        continue;
      }
    }

    const { comment, timeout } = options;
    for (const localPort of localPorts) {
      Ipset.add(setName, `${localAddr},${protocol}:${localPort},${remoteAddr}`, { comment, timeout });
    }
  }
}

async function batchSetupIpset(elements, ipset, remove = false, options = {}) {
  if (!_.isArray(elements) || elements.length === 0)
    return;
  const v4Set = ipset;
  const v6Set = ipset + '6';
  const gateway6 = sysManager.myDefaultGateway6();
  const gateway = sysManager.myDefaultGateway();

  for (const element of elements) {
    const ipSpliterIndex = element.search(/[/,]/)
    const ipAddr = ipSpliterIndex > 0 ? element.substring(0, ipSpliterIndex) : element;

    //Prevent gateway IP from being added into blocking IP set dynamically
    if (!remove && (gateway == ipAddr || gateway6 == ipAddr)) {
      continue;
    }

    let setName;
    // check and add v6 suffix
    if (ipAddr.match(/^\d+(-\d+)?$/)) {
      // ports
      setName = v4Set;
    } else if (new Address4(ipAddr).isValid()) {
      setName = v4Set;
    } else {
      const ip6 = new Address6(ipAddr);
      if (ip6.isValid() && ip6.correctForm() != '::') {
        setName = v6Set;
      }
    }
    if (!setName) continue;

    if (remove)
      Ipset.del(setName, ipAddr);
    else
      Ipset.add(setName, ipAddr, { comment: options.comment });
  }
}

function setupIpset(element, ipset, remove = false) {
  const ipSpliterIndex = element.search(/[/,]/)
  const ipAddr = ipSpliterIndex > 0 ? element.substring(0, ipSpliterIndex) : element;

  // check and add v6 suffix
  if (ipAddr.match(/^\d+(-\d+)?$/)) {
    // ports
  } else if (new Address4(ipAddr).isValid()) {
    // cidr with subnet mask 0 is invalid in ipset, need to convert it to two /1 cidrs
    if (element.endsWith("/0")) {
      return Promise.all([setupIpset("0.0.0.0/1", ipset, remove), setupIpset("128.0.0.0/1", ipset, remove)]);
    }
  } else {
    const ip6 = new Address6(ipAddr);
    if (ip6.isValid()) {
      // cidr with subnet mask 0 is invalid in ipset, need to convert it to two /1 cidrs
      if (element.endsWith("/0")) {
        return Promise.all([setupIpset("::/1", ipset, remove), setupIpset("8000::/1", ipset, remove)]);
      }
      ipset = ipset + '6';
    } else {
      return
    }
  }
  const gateway6 = sysManager.myDefaultGateway6()
  const gateway = sysManager.myDefaultGateway()
  //Prevent gateway IP from being added into blocking IP set dynamically
  if (!remove && (gateway == ipAddr || gateway6 == ipAddr)) {
    log.warn('Not adding gateway IP into ipset', ipAddr, ipset);
    return
  }
  const action = remove ? Ipset.del : Ipset.add;

  log.debug('setupIpset', action.prototype.constructor.name, ipset, element)

  return action(ipset, element)
}

async function setupGlobalRules(options) {
  let { pid, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto,
    action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null,
    trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes,
    wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost,
    subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass, increaseLatency, dropPacketRate
  } = options
  log.verbose(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${rateLimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}, increaseLatency ${increaseLatency}, dropPacketRate ${dropPacketRate}`);
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
      const model = platform.getName();
      let rootClassId = "1";
      if (model === "gold" || model === "goldpro") {
        rootClassId = "10";
      }
      if (rateLimit || qdisc === "netem") {
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit, priority, qdisc, flowIsolation, increaseLatency, dropPacketRate);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit);
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
      }
      if(qdisc === "netem"){
        // currently, only App Disturb will use netem and app disturb not controlled by FW_QOS_SWITCH
        const fwmark_disturb = qos.SKIP_QOS_SWITCH | fwmark;
        const fwmask_disturb = qos.SKIP_QOS_SWITCH | fwmask;
        parameters.push({ table: "mangle", chain: `FW_DISTURB_QOS_GLOBAL`, target: `CONNMARK --set-xmark 0x${fwmark_disturb.toString(16)}/0x${fwmask_disturb.toString(16)}` });
      } else {
        parameters.push({ table: "mangle", chain: `FW_QOS_GLOBAL_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}` });
      }
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
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_GLOBAL_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_GLOBAL_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_GLOBAL_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_GLOBAL_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_GLOBAL_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
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

  const ruleOptions = await prepareOutboundOptions(options)
  const local = {
    set: platform.isFireRouterManaged() ? Ipset.CONSTANTS.IPSET_MONITORED_NET : null,
    specs: platform.isFireRouterManaged() ? ['src','src'] : null,
    positive: true,
    portSet: localPortSet,
  }
  local.set6 = local.set;
  ruleOptions.src = local;

  const rules = [];
  for (const parameter of parameters) {
    rules.push(... await generateRules(Object.assign({}, ruleOptions, parameter)))
  }
  for (const ruleOpt of rules) {
    await manipulateFiveTupleRule(ruleOpt)
  }
}

async function setupGenericIdentitiesRules(options) {
  let { pid, guids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto,
    action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null,
    trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes,
    wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost,
    subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass, increaseLatency, dropPacketRate
  } = options
  log.verbose(`${createOrDestroy} generic identity rule, guids ${JSON.stringify(guids)}, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${rateLimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}, increaseLatency ${increaseLatency}, dropPacketRate ${dropPacketRate}`);
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
      const model = platform.getName();
      let rootClassId = "1";
      if (model === "gold" || model === "goldpro") {
        rootClassId = "10";
      }
      if (rateLimit || qdisc === "netem") {
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit, priority, qdisc, flowIsolation, increaseLatency, dropPacketRate);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit);
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
      }
      if(qdisc === "netem"){
        // currently, only App Disturb will use netem and app disturb not controlled by FW_QOS_SWITCH
        const fwmark_disturb = qos.SKIP_QOS_SWITCH | fwmark;
        const fwmask_disturb = qos.SKIP_QOS_SWITCH | fwmask;
        parameters.push({ table: "mangle", chain: `FW_DISTURB_QOS_DEV`, target: `CONNMARK --set-xmark 0x${fwmark_disturb.toString(16)}/0x${fwmask_disturb.toString(16)}` });
      } else {
        parameters.push({ table: "mangle", chain: `FW_QOS_DEV_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}` });
      }
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
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
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
  const IdentityManager = require('../net2/IdentityManager.js');

  const ruleOptions = await prepareOutboundOptions(options)

  const rules = [];
  for (const guid of guids) {
    const local = {
      specs: ['src'],
      positive: true,
      portSet: localPortSet,
    }
    const identityClass = IdentityManager.getIdentityClassByGUID(guid);
    if (identityClass) {
      const { ns, uid } = IdentityManager.getNSAndUID(guid);
      await identityClass.ensureCreateEnforcementEnv(uid);
      local.set = identityClass.getEnforcementIPsetName(uid, 4);
      local.set6 = identityClass.getEnforcementIPsetName(uid, 6);
    }
    if (!local.set) {
      log.error(`Cannot find localSet of guid ${guid}`);
      continue;
    }
    ruleOptions.src = local;
    for (const parameter of parameters) {
      rules.push(... await generateRules(Object.assign({}, ruleOptions, parameter)))
    }
  }
  for (const ruleOpt of rules) {
    await manipulateFiveTupleRule(ruleOpt)
  }
}

// device-wise rules
async function setupDevicesRules(options) {
  let { pid, macAddresses = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto,
    action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null,
    trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes,
    wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost,
    subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass, increaseLatency, dropPacketRate
  } = options
  log.verbose(`${createOrDestroy} device rule, MAC address ${JSON.stringify(macAddresses)}, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${rateLimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}, increaseLatency ${increaseLatency}, dropPacketRate ${dropPacketRate}`);
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
      const model = platform.getName();
      let rootClassId = "1";
      if (model === "gold" || model === "goldpro") {
        rootClassId = "10";
      }
      if (rateLimit || qdisc === "netem") {
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit, priority, qdisc, flowIsolation, increaseLatency, dropPacketRate);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit);
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
      }
      if(qdisc === "netem"){
        // currently, only App Disturb will use netem and app disturb not controlled by FW_QOS_SWITCH
        const fwmark_disturb = qos.SKIP_QOS_SWITCH | fwmark;
        const fwmask_disturb = qos.SKIP_QOS_SWITCH | fwmask;
        parameters.push({ table: "mangle", chain: `FW_DISTURB_QOS_DEV`, target: `CONNMARK --set-xmark 0x${fwmark_disturb.toString(16)}/0x${fwmask_disturb.toString(16)}` });
      } else {
        parameters.push({ table: "mangle", chain: `FW_QOS_DEV_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}` });
      }
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
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
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

  const ruleOptions = await prepareOutboundOptions(options)

  const rules = [];
  const Host = require('../net2/Host.js');
  for (const mac of macAddresses) {
    await Host.ensureCreateEnforcementEnv(mac);
    const local = {
      set: Host.getDeviceSetName(mac),
      specs: ['src'],
      positive: true,
      portSet: localPortSet,
    }
    local.set6 = local.set;
    ruleOptions.src = local;
    for (const parameter of parameters) {
      rules.push(... await generateRules(Object.assign({}, ruleOptions, parameter)))
    }
  }
  for (const ruleOpt of rules) {
    await manipulateFiveTupleRule(ruleOpt)
  }
}

async function setupTagsRules(options) {
  let { pid, uids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto,
    action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null,
    trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes,
    wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost,
    subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass, increaseLatency, dropPacketRate
  } = options
  log.verbose(`${createOrDestroy} group rule, policy id ${pid}, group uid ${JSON.stringify(uids)}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${rateLimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}, increaseLatency ${increaseLatency}, dropPacketRate ${dropPacketRate}`);
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
        const model = platform.getName();
        let rootClassId = "1";
        if (model === "gold" || model === "goldpro") {
          rootClassId = "10";
        }
        if (rateLimit || qdisc === "netem") {
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
            await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
            await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit, priority, qdisc, flowIsolation, increaseLatency, dropPacketRate);
            await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
          } else {
            await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
            await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit);
            await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
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
            await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
          else
            await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
        }
        if(qdisc === "netem"){
          // currently, only App Disturb will use netem and app disturb not controlled by FW_QOS_SWITCH
          const fwmark_disturb = qos.SKIP_QOS_SWITCH | fwmark;
          const fwmask_disturb = qos.SKIP_QOS_SWITCH | fwmask;
          parameters.push({ table: "mangle", chain: `FW_DISTURB_QOS_DEV_G`, target: `CONNMARK --set-xmark 0x${fwmark_disturb.toString(16)}/0x${fwmask_disturb.toString(16)}`, localSet: devSet, localFlagCount: 1 });
          parameters.push({ table: "mangle", chain: `FW_DISTURB_QOS_NET_G`, target: `CONNMARK --set-xmark 0x${fwmark_disturb.toString(16)}/0x${fwmask_disturb.toString(16)}`, localSet: netSet, localFlagCount: 2 });
        } else {
          parameters.push({ table: "mangle", chain: `FW_QOS_DEV_G_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`, localSet: devSet, localFlagCount: 1 });
          parameters.push({ table: "mangle", chain: `FW_QOS_NET_G_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}`, localSet: netSet, localFlagCount: 2 });
        }
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
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: devSet, localFlagCount: 1 });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: netSet, localFlagCount: 2 });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_DEVICE_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark`, localSet: devSet, localFlagCount: 1 });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_NETWORK_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark`, localSet: netSet, localFlagCount: 2 });
        } else {
          if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
            const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
            const VirtWanGroup = require('../net2/VirtWanGroup.js');
            await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: devSet, localFlagCount: 1 });
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: netSet, localFlagCount: 2 });
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_DEVICE_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark`, localSet: devSet, localFlagCount: 1 });
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_NETWORK_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark`, localSet: netSet, localFlagCount: 2 });
          } else {
            const NetworkProfile = require('../net2/NetworkProfile.js');
            await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_DEVICE_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: devSet, localFlagCount: 1 });
            parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_TAG_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second`, localSet: netSet, localFlagCount: 2 });
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
        parameters.push({ table: "nat", chain: `FW_PR_SNAT_DEV_G_${subPrio}`, target: `SNAT --to-source ${snatIP}`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "nat", chain: `FW_PR_SNAT_NET_G_${subPrio}`, target: `SNAT --to-source ${snatIP}`, localSet: netSet, localFlagCount: 2 });
        break;
      }
      case "block":
      default: {
        parameters.push({ table: "filter", chain: "FW_FIREWALL_DEV_G_BLOCK" + chainSuffix, target: `MARK --set-xmark ${pid}/0xffff`, localSet: devSet, localFlagCount: 1 });
        parameters.push({ table: "filter", chain: "FW_FIREWALL_NET_G_BLOCK" + chainSuffix, target: `MARK --set-xmark ${pid}/0xffff`, localSet: netSet, localFlagCount: 2 });
      }
    }
  }

  const ruleOptions = await prepareOutboundOptions(options)

  const rules = [];

  for (const parameter of parameters) {
    const { table, chain, target, limit, localSet, localFlagCount } = parameter;
    const local = {
      set: localSet,
      set6: localSet,
      specs: new Array(localFlagCount).fill("src"),
      positive: true,
      portSet: localPortSet,
    }
    ruleOptions.src = local;
    rules.push(... await generateRules(Object.assign({}, ruleOptions, {table, chain, target, limit})))
  }
  for (const ruleOpt of rules) {
    await manipulateFiveTupleRule(ruleOpt)
  }
}

async function setupIntfsRules(options) {
  let { pid, uuids = [], localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto,
    action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null,
    trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes,
    wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost,
    subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass, increaseLatency, dropPacketRate
  } = options
  log.verbose(`${createOrDestroy} network rule, policy id ${pid}, uuid ${JSON.stringify(uuids)}, local port ${localPortSet}, remote set ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${rateLimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, security ${security}, target rule group UUID ${targetRgId}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}, increaseLatency ${increaseLatency}, dropPacketRate ${dropPacketRate}`);
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
  const NetworkProfile = require('../net2/NetworkProfile.js');
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
      const model = platform.getName();
      let rootClassId = "1";
      if (model === "gold" || model === "goldpro") {
        rootClassId = "10";
      }
      if (rateLimit || qdisc === "netem") {
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit, priority, qdisc, flowIsolation, increaseLatency, dropPacketRate);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit);
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
      }
      if(qdisc === "netem"){
        // currently, only App Disturb will use netem and app disturb not controlled by FW_QOS_SWITCH
        const fwmark_disturb = qos.SKIP_QOS_SWITCH | fwmark;
        const fwmask_disturb = qos.SKIP_QOS_SWITCH | fwmask;
        parameters.push({ table: "mangle", chain: `FW_DISTURB_QOS_NET`, target: `CONNMARK --set-xmark 0x${fwmark_disturb.toString(16)}/0x${fwmask_disturb.toString(16)}` });
      } else {
        parameters.push({ table: "mangle", chain: `FW_QOS_NET_${subPrio}`, target: `CONNMARK --set-xmark 0x${fwmark.toString(16)}/0x${fwmask.toString(16)}` });
      }
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
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_NETWORK_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_NETWORK_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `FW_${hardRoute ? "RT" : "SRT"}_NETWORK_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
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

  const ruleOptions = await prepareOutboundOptions(options)

  const rules = [];

  for (const uuid of uuids) {
    await NetworkProfile.ensureCreateEnforcementEnv(uuid);
    const local = {
      set: NetworkProfile.getNetIpsetName(uuid, 4),
      set6: NetworkProfile.getNetIpsetName(uuid, 6),
      specs: ["src", "src"],
      positive: true,
      portSet: localPortSet,
    }
    ruleOptions.src = local;
    for (const parameter of parameters) {
      rules.push(... await generateRules(Object.assign({}, ruleOptions, parameter)))
    }
  }
  for (const ruleOpt of rules) {
    await manipulateFiveTupleRule(ruleOpt)
  }
}

async function setupRuleGroupRules(options) {
  let { pid, ruleGroupUUID, localPortSet = null, remoteSet4, remoteSet6, remoteTupleCount = 1, remotePositive = true, remotePortSet, proto,
    action = "block", direction = "bidirection", createOrDestroy = "create", ctstate = null,
    trafficDirection, rateLimit, priority, qdisc, transferredBytes, transferredPackets, avgPacketBytes,
    wanUUID, security, targetRgId, seq = Constants.RULE_SEQ_REG, tlsHostSet, tlsHost,
    subPrio, routeType, qosHandler, upnp, owanUUID, origDst, origDport, snatIP, flowIsolation, dscpClass, increaseLatency, dropPacketRate
  } = options
  log.verbose(`${createOrDestroy} global rule, policy id ${pid}, local port: ${localPortSet}, remote set4 ${remoteSet4}, remote set6 ${remoteSet6}, remote port ${remotePortSet}, protocol ${proto}, action ${action}, direction ${direction}, ctstate ${ctstate}, traffic direction ${trafficDirection}, rate limit ${rateLimit}, priority ${priority}, qdisc ${qdisc}, transferred bytes ${transferredBytes}, transferred packets ${transferredPackets}, average packet bytes ${avgPacketBytes}, wan UUID ${wanUUID}, parent rule group UUID ${ruleGroupUUID}, rule seq ${seq}, tlsHostSet ${tlsHostSet}, tlsHost ${tlsHost}, subPrio ${subPrio}, routeType ${routeType}, qosHandler ${qosHandler}, upnp ${upnp}, owanUUID ${owanUUID}, origDst ${origDst}, origDport ${origDport}, snatIP ${snatIP}, flowIsolation ${flowIsolation}, dscpClass ${dscpClass}, increaseLatency ${increaseLatency}, dropPacketRate ${dropPacketRate}`);
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
      const model = platform.getName();
      let rootClassId = "1";
      if (model === "gold" || model === "goldpro") {
        rootClassId = "10";
      }
      if (rateLimit || qdisc === "netem") {
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
          await qos.createQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit, priority, qdisc, flowIsolation, increaseLatency, dropPacketRate);
          await qos.createTCFilter(qosHandler, parentHTBQdisc, qosHandler, trafficDirection, filterPrio, fwmark);
        } else {
          await qos.destroyTCFilter(qosHandler, parentHTBQdisc, trafficDirection, filterPrio, fwmark);
          await qos.destroyQoSClass(qosHandler, parentHTBQdisc, trafficDirection, rateLimit);
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
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
          await qos.createTCFilter(qosHandler, rootClassId, subclassId, trafficDirection, filterPrio, fwmark);
        else
          await qos.destroyTCFilter(qosHandler, rootClassId, trafficDirection, filterPrio, fwmark);
      }
      //TODO: Not consider how App Disturb feature use RuleGroup Qos currently.
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
        parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, hardRoute ? "route" : "soft_route")}_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
        parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, hardRoute ? "route" : "soft_route")}_${subPrio}`, target: `SET --map-set ${VPNClient.getRouteIpsetName(profileId, hardRoute)} dst,dst --map-mark` });
      } else {
        if (wanUUID.startsWith(VIRT_WAN_GROUP_PREFIX)) {
          const uuid = wanUUID.substring(VIRT_WAN_GROUP_PREFIX.length);
          const VirtWanGroup = require('../net2/VirtWanGroup.js');
          await VirtWanGroup.ensureCreateEnforcementEnv(uuid);
          parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, hardRoute ? "route" : "soft_route")}_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
          parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, hardRoute ? "route" : "soft_route")}_${subPrio}`, target: `SET --map-set ${VirtWanGroup.getRouteIpsetName(uuid, hardRoute)} dst,dst --map-mark` });
        } else {
          const NetworkProfile = require('../net2/NetworkProfile.js');
          await NetworkProfile.ensureCreateEnforcementEnv(wanUUID);
          parameters.push({ table: "mangle", chain: `${getRuleGroupChainName(ruleGroupUUID, hardRoute ? "route" : "soft_route")}_${subPrio}`, target: `LOG --log-prefix "[FW_ADT]A=R M=${pid} "`, limit: `${routeLogRateLimitPerSecond}/second` });
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
  const ruleOptions = await prepareOutboundOptions(options)
  const local = {
    set: platform.isFireRouterManaged() ? Ipset.CONSTANTS.IPSET_MONITORED_NET : null,
    specs: platform.isFireRouterManaged() ? ['src','src'] : null,
    positive: true,
    portSet: localPortSet,
  }
  local.set6 = local.set;
  ruleOptions.src = local;

  const rules = [];
  for (const parameter of parameters) {
    rules.push(... await generateRules(Object.assign({}, ruleOptions, parameter)))
  }
  for (const ruleOpt of rules) {
    await manipulateFiveTupleRule(ruleOpt)
  }
}

async function prepareOutboundOptions(options) {
  const { pid, remoteSet4, remoteSet6, remoteTupleCount = 1, remoteNegate = false,
    remotePortSet, remotePortNegate = false, proto,
    direction, createOrDestroy = "create", ctstate = null,
    transferredBytes, transferredPackets, avgPacketBytes,
    tlsHostSet, tlsHost, upnp, owanUUID, origDst, origDport, dscpClass,
    connSet4 = null, connSet6 = null
  } = options;

  const remote = {
    set: remoteSet4,
    set6: remoteSet6,
    specs: new Array(remoteTupleCount).fill("dst"),
    negate: remoteNegate,
    portSet: remotePortSet,
    portNegate: remotePortNegate,
  }
  const conn = {
    specs: ["src", "src", "dst"],
    set: connSet4,
    set6: connSet6
  }

  if (owanUUID) {
    if (owanUUID.startsWith(VPN_CLIENT_WAN_PREFIX)) {
      const profileId = owanUUID.substring(VPN_CLIENT_WAN_PREFIX.length);
      await VPNClient.ensureCreateEnforcementEnv(profileId);
      remote.ifSet = VPNClient.getOifIpsetName(profileId);
    } else {
      const NetworkProfile = require('../net2/NetworkProfile.js');
      await NetworkProfile.ensureCreateEnforcementEnv(owanUUID);
      remote.ifSet = NetworkProfile.getOifIpsetName(owanUUID);
    }
  }

  return {
    direction,
    action: createOrDestroy === 'create' ? '-A' : '-D',
    isSnat: (options.action && options.action === "snat") || false,
    dst: remote,
    conn: conn,
    proto, af: 4, comment: `rule_${pid}`, ctstate,
    transferredBytes, transferredPackets, avgPacketBytes,
    tlsHostSet, tlsHost,
    upnp, origDst, origDport, dscpClass
  }
}

function flipSrcDst(options) {
  const result = JSON.parse(JSON.stringify(options))
  const tmp = result.src
  result.src = result.dst
  result.dst = tmp;
  for (const group of ['src', 'dst', 'conn']) {
    const groupSpecs = result[group].specs;
    for (const index in groupSpecs) {
      if (groupSpecs[index] == 'src')
        groupSpecs[index] = 'dst';
      else if (groupSpecs[index] == 'dst')
        groupSpecs[index] = 'src';
    }
  }
  return result
}

function generateV46Rule(ruleOptions) {
  const { upnp, isSnat } = ruleOptions;
  const rules = []
  rules.push({ ...ruleOptions, af: 4 })
  if (!upnp && !isSnat) rules.push({ ...ruleOptions, af: 6 })
  return rules
}

async function generateRules(ruleOptions) {
  const { direction, trafficDirection, transferredBytes, transferredPackets, avgPacketBytes, dscpClass, isSnat } = ruleOptions

  const rules = []
  // log.debug(`generateRules ${JSON.stringify(ruleOptions)}`)

  if (direction === 'bidirection' && trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)
    || direction === 'outbound'
  ) {
    ruleOptions.transferDirection = trafficDirection ? (trafficDirection === 'upload' ? 'original' : 'reply') : null
    if (!dscpClass || !trafficDirection || trafficDirection === "upload")
      rules.push(...generateV46Rule({ ...ruleOptions, ctDir: 'ORIGINAL' }))
    if ((!dscpClass || !trafficDirection || trafficDirection === "download") && !isSnat)
      rules.push(...generateV46Rule(flipSrcDst({ ...ruleOptions, ctDir: 'REPLY' })))
  }
  if (direction === 'bidirection' && trafficDirection && (transferredBytes || transferredPackets || avgPacketBytes)
    || direction === 'inbound'
  ) {
    ruleOptions.transferDirection = trafficDirection ? (trafficDirection === 'upload' ? 'reply' : 'original') : null
    if (!dscpClass || !trafficDirection || trafficDirection === "upload")
      rules.push(...generateV46Rule({ ...ruleOptions, ctDir: 'REPLY' }))
    if (!dscpClass || !trafficDirection || trafficDirection === "download")
      rules.push(...generateV46Rule(flipSrcDst({ ...ruleOptions, ctDir: 'ORIGINAL' })))
  }
  if (direction === 'bidirection' && (!trafficDirection || (!transferredBytes && !transferredPackets && !avgPacketBytes))) {
    if (!dscpClass || !trafficDirection || trafficDirection === "upload")
      rules.push(...generateV46Rule(ruleOptions))
    if (!dscpClass || !trafficDirection || trafficDirection === "download")
      rules.push(...generateV46Rule(flipSrcDst(ruleOptions)))
  }

  // log.debug('generateRules', rules)
  return rules
}

async function manipulateFiveTupleRule(options) {
  const { action, src, dst, proto, ctDir, target, chain, table, limit, af = 4, comment, ctstate,
    transferredBytes, transferredPackets, avgPacketBytes, transferDirection, tlsHostSet, tlsHost, origDst, origDport, dscpClass,
    conn
  } = options;
  // sport and dport can be range string, e.g., 10000-20000
  const rule = new Rule(table).fam(af).chn(chain);
  const srcSet = af == 4 ? src.set : src.set6;
  const connSet = af == 4 ? conn.set : conn.set6;
  if (srcSet)
    rule.set(srcSet, src.specs.join(","), src.negate);
  if (src.portSet)
    rule.set(src.portSet, 'src', src.portNegate);
  const dstSet = af == 4 ? dst.set : dst.set6;
  if (dstSet)
    rule.set(dstSet, dst.specs.join(","), dst.negate);
  if (connSet)
    rule.set(connSet, conn.specs.join(","), conn.negate);
  if (dst.portSet)
    rule.set(dst.portSet, 'dst', dst.portNegate);
  if (src.ifSet)
    rule.set(src.ifSet, 'src,src');
  if (dst.ifSet)
    rule.set(dst.ifSet, 'dst,dst');
  if (origDst)
    rule.mdl("conntrack", `--ctorigdst ${origDst}`);
  if (origDport)
    rule.mdl("conntrack", `--ctorigdstport ${origDport}`);
  if (proto && proto != '')
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
    if (proto === "tcp" && platform.isTLSBlockSupport())
      rule.mdl("tls", `--tls-hostset ${tlsHostSet}`);
    else if (proto === "udp" && platform.isUdpTLSBlockSupport())
      rule.mdl("udp_tls", `--tls-hostset ${tlsHostSet}`);
  }
  if (tlsHost) {
    if (proto === "tcp" && platform.isTLSBlockSupport())
      rule.mdl("tls", `--tls-host ${tlsHost}`)
    else if (proto === "udp" && platform.isUdpTLSBlockSupport())
      rule.mdl("udp_tls", `--tls-host ${tlsHost}`)
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
  iptc.addRule(rule.opr(action));
}


module.exports = {
  setupBlockChain,
  batchBlock,
  batchUnblock,
  batchBlockNetPort,
  batchUnblockNetPort,
  batchBlockConnection,
  block,
  unblock,
  setupCategoryEnv,
  setupGlobalRules,
  setupDevicesRules,
  setupGenericIdentitiesRules,
  getTLSHostSet,
  getDstSet,
  getDstSet6,
  getConnSet,
  getConnSet6,
  getPredefinedConnSet,
  getPredefinedConnSet6,
  getMacSet,
  setupTagsRules,
  setupIntfsRules,
  setupRuleGroupRules,
  manipulateFiveTupleRule,
  VPN_CLIENT_WAN_PREFIX,
  VIRT_WAN_GROUP_PREFIX
}
