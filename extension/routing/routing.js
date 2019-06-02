#!/usr/bin/env node
/*    Copyright 2016 Firewalla LLC / Firewalla LLC
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

const cp = require('child_process');

const util = require('util');

const execAsync = util.promisify(cp.exec);

async function createCustomizedRoutingTable(tableName) {
  let cmd = "cat /etc/iproute2/rt_tables | grep -v '#' | awk '{print $1,\"\\011\",$2}'";
  let result = await execAsync(cmd);
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
      log.info("Table with same name already exists: " + tid);
      return Number(tid);
    }
  }
  // find unoccupied table id between 100-199
  let id = 100;
  while (id < 200) {
    if (!usedTid.includes(id + "")) // convert number to string
      break;
    id++;
  }
  if (id == 200) {
    throw "Insufficient space to create routing table";
  }
  cmd = util.format("sudo bash -c 'echo -e %d\\\\t%s >> /etc/iproute2/rt_tables'", id, tableName);
  log.info("Append new routing table: ", cmd);
  result = await execAsync(cmd);
  if (result.stderr !== "") {
    log.error("Failed to create customized routing table.", result.stderr);
    throw result.stderr;
  }
  return id;
}

async function createPolicyRoutingRule(from, tableName) {
  let cmd = "ip rule list";
  let result = await execAsync(cmd);
  if (result.stdout.includes(util.format("from %s lookup %s", from, tableName))) {
    log.info("same ip rule already exists");
    return;
  }  
  cmd = util.format('sudo ip rule add from %s lookup %s', from, tableName);
  log.info("Create new policy routing rule: ", cmd);
  let {stdout, stderr} = await execAsync(cmd);
  if (stderr !== "") {
    log.error("Failed to create policy routing rule.", stderr);
    throw stderr;
  }
}

async function removePolicyRoutingRule(from, tableName) {
  let cmd = util.format('sudo ip rule del from %s', from);
  if (tableName)
    cmd = util.format('%s lookup %s', cmd, tableName);
  log.info("Remove policy routing rule: ", cmd);
  let {stdout, stderr} = await execAsync(cmd);
  if (stderr !== "") {
    log.error("Failed to remove policy routing rule.", stderr);
    throw stderr;
  }
}

async function addRouteToTable(dest, gateway, intf, tableName) {
  let cmd = null;
  dest = dest || "default";
  tableName = tableName || "main";
  if (gateway) {
    cmd = util.format('sudo ip route add %s via %s dev %s table %s', dest, gateway, intf, tableName);
  } else {
    cmd = util.format('sudo ip route add %s dev %s table %s', dest, intf, tableName);
  }
  let {stdout, stderr} = await execAsync(cmd);
  if (stderr !== "") {
    log.error("Failed to add route to table.", stderr);
    throw stderr;
  }
}

async function removeRouteFromTable(dest, gateway, intf, tableName) {
  let cmd = null;
  dest = dest || "default";
  tableName = tableName || "main";
  if (gateway) {
    cmd = util.format('sudo ip route del %s via %s dev %s table %s', dest, gateway, intf, tableName);
  } else {
    cmd = util.format('sudo ip route del %s dev %s table %s', dest, intf, tableName);
  }
  let {stdout, stderr} = await execAsync(cmd);
  if (stderr !== "") {
    log.error("Failed to remove route from table.", stderr);
    throw stderr;
  }
}

async function flushRoutingTable(tableName) {
  let cmd = util.format('sudo ip route flush table %s', tableName);
  let {stdout, stderr} = await execAsync(cmd);
  if (stderr !== "") {
    log.error("Failed to flush routing table.", stderr);
    throw stderr;
  }
}

async function testRoute(dstIp, srcIp, srcIntf) {
  try {
    let cmd = util.format('ip route get to %s from %s iif %s', dstIp, srcIp, srcIntf);
    let {stdout, stderr} = await execAsync(cmd);
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

module.exports = {
  createCustomizedRoutingTable: createCustomizedRoutingTable,
  createPolicyRoutingRule: createPolicyRoutingRule,
  removePolicyRoutingRule: removePolicyRoutingRule,
  addRouteToTable: addRouteToTable,
  removeRouteFromTable: removeRouteFromTable,
  flushRoutingTable: flushRoutingTable,
  testRoute: testRoute
}