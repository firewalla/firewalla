/*    Copyright 2016 - 2020 Firewalla Inc
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

const log = require('../net2/logger.js')(__filename);

const exec = require('child-process-promise').exec;
const rclient = require('../util/redis_manager.js').getRedisClient();

const POLICY_QOS_HANDLER_MAP_KEY = "policy_qos_handler_map";
const QOS_UPLOAD_MASK = 0x3f800000;
const QOS_DOWNLOAD_MASK = 0x7f0000;
const QOS_SWITCH_MASK = 0x40000000;
const DEFAULT_PRIO = 4;
const DEFAULT_RATE_LIMIT = "10240mbit";
const pl = require('../platform/PlatformLoader.js');
const platform = pl.getPlatform();

async function getQoSHandlerForPolicy(pid) {
  const policyHandlerMap = (await rclient.hgetallAsync(POLICY_QOS_HANDLER_MAP_KEY)) || {};
  if (policyHandlerMap[`policy_${pid}`])
    return policyHandlerMap[`policy_${pid}`];
  else
    return null;
}

async function getPolicyForQosHandler(handlerId) {
  const policyHandlerMap = (await rclient.hgetallAsync(POLICY_QOS_HANDLER_MAP_KEY)) || {};
  if (policyHandlerMap[`qos_${handlerId}`])
    return policyHandlerMap[`qos_${handlerId}`];
  else
    return null;
}

async function allocateQoSHanderForPolicy(pid) {
  const policyHandlerMap = (await rclient.hgetallAsync(POLICY_QOS_HANDLER_MAP_KEY)) || {};
  if (policyHandlerMap[`policy_${pid}`])
    return policyHandlerMap[`policy_${pid}`];
  else {
    for (let i = 2; i != 128; i++) {
      if (!policyHandlerMap[`qos_${i}`]) {
        await rclient.hmsetAsync(POLICY_QOS_HANDLER_MAP_KEY, `policy_${pid}`, i, `qos_${i}`, pid);
        return i;
      }
    }
    return null;
  }
}

async function deallocateQoSHandlerForPolicy(pid) {
  const qosHandler = await rclient.hgetAsync(POLICY_QOS_HANDLER_MAP_KEY, `policy_${pid}`);
  if (qosHandler) {
    await rclient.hdelAsync(POLICY_QOS_HANDLER_MAP_KEY, `qos_${qosHandler}`);
    await rclient.hdelAsync(POLICY_QOS_HANDLER_MAP_KEY, `policy_${pid}`);
  }
}

async function createQoSClass(classId, direction, rateLimit, priority, qdisc, isolation) {
  if (!platform.isIFBSupported()) {
    log.error("ifb is not supported on this platform");
    return;
  }
  qdisc = qdisc || "fq_codel";
  rateLimit = rateLimit || DEFAULT_RATE_LIMIT;
  if (!isNaN(rateLimit)) // default unit of rate limit is mbit
    rateLimit = `${rateLimit}mbit`;
  priority = priority || DEFAULT_PRIO;
  log.info(`Creating QoS class for classid ${classId}, direction ${direction}, rate limit ${rateLimit}, priority ${priority}, qdisc ${qdisc}`);
  if (!classId) {
    log.error(`class id is not specified`);
    return;
  }
  if (!direction) {
    log.error(`direction is not specified`);
    return;
  }
  const device = direction === 'upload' ? 'ifb0' : 'ifb1';
  classId = Number(classId).toString(16);
  switch (qdisc) {
    case "fq_codel": {
      await exec(`sudo tc class replace dev ${device} parent 1: classid 1:0x${classId} htb prio ${priority} rate ${rateLimit}`).then(() => {
        return exec(`sudo tc qdisc replace dev ${device} parent 1:0x${classId} ${qdisc}`);
      }).catch((err) => {
        log.error(`Failed to create QoS class ${classId}, direction ${direction}`, err.message);
      });
      break;
    }
    case "cake": {
      switch (isolation) {
        case "host": {
          isolation = direction === "upload" ? "dual-srchost" : "dual-dsthost";
          break;
        }
        default:
          isolation = "triple-isolate";
      }
      // use bandwidth param on cake qdisc instead of rate param on htb class
      await exec(`sudo tc class replace dev ${device} parent 1: classid 1:0x${classId} htb prio ${priority} rate ${DEFAULT_RATE_LIMIT}`).then(() => {
        return exec(`sudo tc qdisc replace dev ${device} parent 1:0x${classId} ${qdisc} ${rateLimit == DEFAULT_RATE_LIMIT ? "unlimited" : `bandwidth ${rateLimit}`} ${isolation}`);
      }).catch((err) => {
        log.error(`Failed to create QoS class ${classId}, direction ${direction}`, err.message);
      });
      break;
    }
    default: {
      log.error(`Unrecognized qdisc ${qdisc}`);
    }
  }
}

async function destroyQoSClass(classId, direction) {
  if (!platform.isIFBSupported()) {
    log.error("ifb is not supported on this platform");
    return;
  }
  log.info(`Destroying QoS class for classid ${classId}, direction ${direction}`);
  if (!classId) {
    log.error(`class id is not specified`);
    return;
  }
  if (!direction) {
    log.error(`direction is not specified`);
    return;
  }
  const device = direction === 'upload' ? 'ifb0' : 'ifb1';
  classId = Number(classId).toString(16);
  // there is a bug in 4.15 kernel which will cause failure to add a filter with the same handle that was used by a deleted filter: https://bugs.launchpad.net/ubuntu/+source/linux/+bug/1797669
  // if the filter cannot be solely deleted, the class cannot be deleted either. We have to replace it with a dummy class
  await exec(`sudo tc class replace dev ${device} classid 1:0x${classId} htb rate ${DEFAULT_RATE_LIMIT} prio ${DEFAULT_PRIO}`).catch((err) => {
    log.error(`Failed to destroy QoS class ${classId}, direction ${direction}`, err.message);
  });
}

async function createTCFilter(filterId, classId, direction, prio, fwmark) {
  if (!platform.isIFBSupported()) {
    log.error("ifb is not supported on this platform");
    return;
  }
  log.info(`Creating tc filter for filter id ${filterId}, classid ${classId}, direction ${direction}, prio ${prio}`)
  if (!filterId) {
    log.error(`filter id is not specified`);
    return;
  }
  if (!classId) {
    log.error(`class id is not specified`);
    return;
  }
  if (!direction) {
    log.error(`direction is not specified`);
    return;
  }
  if (!prio) {
    log.error(`prio is not specified`);
    return;
  }
  if (!fwmark) {
    log.error(`fwmark is not specified`);
    return;
  }
  const device = direction === 'upload' ? 'ifb0' : 'ifb1';
  const fwmask = direction === 'upload' ? QOS_UPLOAD_MASK : QOS_DOWNLOAD_MASK;
  filterId = Number(filterId).toString(16);
  fwmark = (Number(fwmark) | QOS_SWITCH_MASK).toString(16);
  classId = Number(classId).toString(16);
  await exec(`sudo tc filter replace dev ${device} parent 1: handle 800::0x${filterId} prio ${prio} u32 match mark 0x${fwmark} 0x${(fwmask | QOS_SWITCH_MASK).toString(16)} flowid 1:0x${classId}`).catch((err) => {
    log.error(`Failed to create tc filter ${filterId} for class ${classId}, direction ${direction}, prio ${prio}, fwmark ${fwmark}`, err.message);
  });
}

async function destroyTCFilter(filterId, direction, prio, fwmark) {
  if (!platform.isIFBSupported()) {
    log.error("ifb is not supported on this platform");
    return;
  }
  log.info(`Destroying tc filter for filter id ${filterId}, direction ${direction}, prio ${prio}`);
  if (!filterId) {
    log.error(`filter id is not specified`);
    return;
  }
  if (!direction) {
    log.error(`direction is not specified`);
    return;
  }
  if (!prio) {
    log.error(`prio is not specified`);
    return;
  }
  if (!fwmark) {
    log.error(`fwmark is not specified`);
    return;
  }
  const device = direction === 'upload' ? 'ifb0' : 'ifb1';
  const fwmask = direction === 'upload' ? QOS_UPLOAD_MASK : QOS_DOWNLOAD_MASK;
  filterId = Number(filterId).toString(16);
  fwmark = (Number(fwmark) | QOS_SWITCH_MASK).toString(16);
  // there is a bug in 4.15 kernel which will cause failure to add a filter with the same handle that was used by a deleted filter: https://bugs.launchpad.net/ubuntu/+source/linux/+bug/1797669
  // so we have to replace the filter with a dummy one
  await exec(`sudo tc filter replace dev ${device} parent 1: handle 800::0x${filterId} prio ${prio} u32 match mark 0x${fwmark} 0x${(fwmask | QOS_SWITCH_MASK).toString(16)} flowid 1:1`).catch((err) => {
    log.error(`Failed to destory tc filter ${filterId}, direction ${direction}, prio ${prio}`, err.message);
  });
}

module.exports = {
  QOS_UPLOAD_MASK,
  QOS_DOWNLOAD_MASK,
  getQoSHandlerForPolicy,
  getPolicyForQosHandler,
  allocateQoSHanderForPolicy,
  deallocateQoSHandlerForPolicy,
  createQoSClass,
  destroyQoSClass,
  createTCFilter,
  destroyTCFilter
}