#!/usr/bin/env node
/*    Copyright 2016-2022 Firewalla Inc.
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

const log = require("../../net2/logger.js")(__filename);

const _ = require('lodash');
const AsyncLock = require('../../vendor_lib/async-lock');
const lock = new AsyncLock();

const util = require('util');

const exec = require('child-process-promise').exec;

const RT_TYPE_VC = "RT_TYPE_VC";
const RT_TYPE_REG = "RT_TYPE_REG";
const MASK_REG = "0x3ff";
const MASK_VC = "0xfc00";
const MASK_ALL = "0xffff";

const LOCK_RT_TABLES = "LOCK_RT_TABLES";
const LOCK_FILE = "/tmp/rt_tables.lock";

async function removeCustomizedRoutingTable(tableName) {
  let cmd = `sudo bash -c 'flock ${LOCK_FILE} -c "sed -i -e \\"s/^[[:digit:]]\\+\\s\\+${tableName}$//g\\" /etc/iproute2/rt_tables"'`;
  await exec(cmd);
}

async function createCustomizedRoutingTable(tableName, type = RT_TYPE_REG) {
  return new Promise((resolve, reject) => {
    lock.acquire(LOCK_RT_TABLES, async function(done) {
      // separate bits in fwmark for vpn client and regular WAN
      const bitOffset = type === RT_TYPE_VC ? 10 : 0;
      const maxTableId = type === RT_TYPE_VC ? 64 : 1024;
      let cmd = "cat /etc/iproute2/rt_tables | grep -v '#' | awk '{print $1,\"\\011\",$2}'";
      let result = await exec(cmd);
      if (result.stderr !== "") {
        log.error("Failed to read rt_tables.", result.stderr);
      }
      const entries = result.stdout.split('\n');
      const usedTid = [];
      for (var i in entries) {
        const entry = entries[i];
        const line = entry.split(/\s+/);
        const tid = line[0];
        const name = line[1];
        usedTid.push(tid);
        if (name === tableName) {
          if (Number(tid) >>> bitOffset === 0 || Number(tid) >>> bitOffset >= maxTableId) {
            log.info(`Previous table id of ${tableName} is out of range ${tid}, removing old entry for ${tableName} ...`);
            await removeCustomizedRoutingTable(tableName);
          } else {
            log.debug("Table with same name already exists: " + tid);
            done(null, Number(tid));
            return;
          }
        }
      }
      // find unoccupied table id between 1 - maxTableId
      let id = 1;
      while (id < maxTableId) {
        if (!usedTid.includes((id << bitOffset) + "")) // convert number to string
          break;
        id++;
      }
      if (id == maxTableId) {
        done(`Insufficient space to create routing table for ${tableName}, type ${type}`, null);
        return;
      }
      cmd = `sudo bash -c 'flock ${LOCK_FILE} -c "echo -e ${id << bitOffset}\\\t${tableName} >> /etc/iproute2/rt_tables; \
        cat /etc/iproute2/rt_tables | sort | uniq > /etc/iproute2/rt_tables.new; \
        cp /etc/iproute2/rt_tables.new /etc/iproute2/rt_tables; \
        rm /etc/iproute2/rt_tables.new"'`;
      log.info("Append new routing table: ", cmd);
      result = await exec(cmd);
      if (result.stderr !== "") {
        log.error("Failed to create customized routing table.", result.stderr);
        done(result.stderr, null);
        return;
      }
      done(null, id << bitOffset);
    }, function(err, ret) {
      if (err)
        reject(err);
      else
        resolve(ret);
    });
  });
}

async function createPolicyRoutingRule(from, iif, tableName, priority, fwmark, af = 4) {
  from = from || "all";
  let cmd = `ip -${af} rule list`;
  let result = await exec(cmd);
  let rule = `from ${from} `;
  if (fwmark) {
    if (_.isString(fwmark) && fwmark.includes("/")) {
      const mark = Number(fwmark.split("/")[0]).toString(16);
      const mask = Number(fwmark.split("/")[1]).toString(16);
      rule = `${rule}fwmark 0x${mark}/0x${mask} `;
    } else {
      const mark = Number(fwmark).toString(16);
      rule = `${rule}fwmark 0x${mark} `;
    }
  }
  if (iif && iif !== "")
    rule = `${rule}iif ${iif} `;
  rule = `${rule}lookup ${tableName}`;
  result = result.stdout.replace(/\[detached\] /g, "");
  if (result.includes(rule)) {
    log.debug("Same policy routing rule already exists: ", rule);
    return;
  }
  if (priority)
    rule = `${rule} priority ${priority}`;
  cmd = `sudo ip -${af} rule add ${rule}`;
  log.info("Create new policy routing rule: ", cmd);
  result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to create policy routing rule.", result.stderr);
    throw result.stderr;
  }
}

async function removePolicyRoutingRule(from, iif, tableName, priority, fwmark, af = 4) {
  from = from || "all";
  let cmd = `ip -${af} rule list`;
  let result = await exec(cmd);
  result = result.stdout.replace(/\[detached\] /g, "");
  let rule = `from ${from} `;
  if (fwmark) {
    if (_.isString(fwmark) && fwmark.includes("/")) {
      const mark = Number(fwmark.split("/")[0]).toString(16);
      const mask = Number(fwmark.split("/")[1]).toString(16);
      rule = `${rule}fwmark 0x${mark}/0x${mask} `;
    } else {
      const mark = Number(fwmark).toString(16);
      rule = `${rule}fwmark 0x${mark} `;
    }
  }
  if (iif && iif !== "")
    rule = `${rule}iif ${iif} `;
  rule = `${rule}lookup ${tableName}`;
  if (!result.includes(rule)) {
    log.debug("Policy routing rule does not exist: ", rule);
    return;
  }
  cmd = `sudo ip -${af} rule del ${rule}`;
  log.info("Remove policy routing rule: ", cmd);
  result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to remove policy routing rule.", result.stderr);
    throw result.stderr;
  }
}

async function addRouteToTable(dest, gateway, intf, tableName, preference, af = 4, type = "unicast") {
  dest = dest || "default";
  let route = `${type} ${dest}`;
  tableName = tableName || "main";
  if (intf) {
    if (gateway) {
      route = `${route} via ${gateway} dev ${intf}`;
    } else {
      route = `${route} dev ${intf}`;
    }
  }
  route = `${route} table ${tableName}`;
  if (preference)
    route = `${route} preference ${preference}`;

  try {
    const check = await exec(`ip -${af} route show type ${route}`)
    if (check.stdout.length != 0) {
      log.debug('Route exists, ignored', route)
      return
    }
  } catch(err) {
    log.error('failed to check route presence', err)
  }

  const result = await exec(`sudo ip -${af} route add ${route}`);
  if (result.stderr !== "") {
    log.error("Failed to add route to table.", result.stderr);
    throw result.stderr;
  }
}

async function removeRouteFromTable(dest, gateway, intf, tableName, preference = null, af = 4, type = "unicast") {
  dest = dest || "default";
  tableName = tableName || "main";
  let cmd = `sudo ip -${af} route del ${type} ${dest}`;
  if (gateway) {
    cmd = `${cmd} via ${gateway}`;
  }
  if (intf) {
    cmd = `${cmd} dev ${intf}`;
  }
  cmd = `${cmd} table ${tableName}`;
  if (preference)
    cmd = `${cmd} preference ${preference}`;
  let result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to remove route from table.", result.stderr);
    throw result.stderr;
  }
}

async function flushRoutingTable(tableName, dev = null, proto) {
  const cmds = [
    `sudo ip route flush ${dev ? `dev ${dev}` : "" } proto ${proto ? proto : "boot"} table ${tableName}`, 
    `sudo ip -6 route flush ${dev ? `dev ${dev}` : ""} proto ${proto ? proto : "boot"} table ${tableName}`
  ];
  for (const cmd of cmds) {
    await exec(cmd).catch((err) => {
      log.error(`Failed to flush routing table ${tableName}`, err.message);
    });
  }
}

async function testRoute(dstIp, srcIp, srcIntf) {
  try {
    let cmd = util.format('ip route get to %s from %s iif %s', dstIp, srcIp, srcIntf);
    let {stdout, stderr} = await exec(cmd);
    if (stderr !== "") {
      log.error(util.format("Failed to test route from %s %s to %s", srcIp, srcIntf, dstIp), stderr);
      return null;
    }
    // stdout can be two lines:
    // 8.8.8.8 from 192.168.218.121 via 192.168.7.1 dev eth0
    // cache  iif eth0
    const result = (stdout && stdout.split("\n")[0]) || "";
    const words = result.split(" ");
    const entry = {};
    for (let i = 0; i != words.length; i++) {
      const word = words[i];
      switch (word) {
        case "via":
          entry["via"] = words[++i];
          break;
        case "dev":
          entry["dev"] = words[++i];
          break;
        default:
      }
    }
    return entry;
  } catch (err) {
    log.error(util.format("Failed to test route from %s %s to %s", srcIp, srcIntf, dstIp), err);
    return null;
  }
}

async function addMultiPathRouteToTable(dest, tableName, af = 4, ...multipathDesc) {
  let cmd = null;
  dest = dest || "default";
  cmd =  `sudo ip -${af} route add ${dest}`;
  tableName = tableName || "main";
  cmd = `${cmd} table ${tableName}`;
  for (let desc of multipathDesc) {
    const nextHop = desc.nextHop;
    const dev = desc.dev;
    const weight = desc.weight;
    if (!dev || !weight)
      continue;
    cmd = `${cmd} nexthop via ${nextHop}`;
    if (dev)
      cmd = `${cmd} dev ${dev}`;
    cmd = `${cmd} weight ${weight}`;
  }
  let result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to add multipath route to table.", result.stderr);
    throw result.stderr
  }
}

module.exports = {
  createCustomizedRoutingTable: createCustomizedRoutingTable,
  removeCustomizedRoutingTable: removeCustomizedRoutingTable,
  createPolicyRoutingRule: createPolicyRoutingRule,
  removePolicyRoutingRule: removePolicyRoutingRule,
  addRouteToTable: addRouteToTable,
  removeRouteFromTable: removeRouteFromTable,
  flushRoutingTable: flushRoutingTable,
  testRoute: testRoute,
  addMultiPathRouteToTable: addMultiPathRouteToTable,
  RT_TYPE_REG,
  RT_TYPE_VC,
  MASK_REG,
  MASK_VC,
  MASK_ALL
}
