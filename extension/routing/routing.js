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

const _ = require('lodash');

const util = require('util');

const exec = require('child-process-promise').exec;

async function createCustomizedRoutingTable(tableName) {
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
  cmd = `sudo bash -c 'flock /tmp/rt_tables.lock -c "echo -e ${id}\\\t${tableName} >> /etc/iproute2/rt_tables; \
    cat /etc/iproute2/rt_tables | sort | uniq > /etc/iproute2/rt_tables.new; \
    cp /etc/iproute2/rt_tables.new /etc/iproute2/rt_tables; \
    rm /etc/iproute2/rt_tables.new"'`;
  log.info("Append new routing table: ", cmd);
  result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to create customized routing table.", result.stderr);
    throw result.stderr;
  }
  return id;
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

async function addRouteToTable(dest, gateway, intf, tableName, preference, af = 4) {
  let cmd = null;
  dest = dest || "default";
  tableName = tableName || "main";
  if (gateway) {
    cmd = `sudo ip -${af} route add ${dest} via ${gateway} dev ${intf} table ${tableName}`;
  } else {
    cmd = `sudo ip -${af} route add ${dest} dev ${intf} table ${tableName}`;
  }
  if (preference)
    cmd = `${cmd} preference ${preference}`;
  let result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to add route to table.", result.stderr);
    throw result.stderr;
  }
}

async function removeRouteFromTable(dest, gateway, intf, tableName, af = 4) {
  let cmd = null;
  dest = dest || "default";
  tableName = tableName || "main";
  cmd = `sudo ip -${af} route del ${dest}`;
  if (gateway) {
    cmd = `${cmd} via ${gateway}`;
  }
  if (intf) {
    cmd = `${cmd} dev ${intf}`;
  }
  cmd = `${cmd} table ${tableName}`;
  let result = await exec(cmd);
  if (result.stderr !== "") {
    log.error("Failed to remove route from table.", result.stderr);
    throw result.stderr;
  }
}

async function flushRoutingTable(tableName) {
  const cmds = [`sudo ip route flush table ${tableName}`, `sudo ip -6 route flush table ${tableName}`];
  for (const cmd of cmds) {
    let result = await exec(cmd);
    if (result.stderr !== "") {
      log.error("Failed to flush routing table.", result.stderr);
      throw result.stderr;
    }
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

module.exports = {
  createCustomizedRoutingTable: createCustomizedRoutingTable,
  createPolicyRoutingRule: createPolicyRoutingRule,
  removePolicyRoutingRule: removePolicyRoutingRule,
  addRouteToTable: addRouteToTable,
  removeRouteFromTable: removeRouteFromTable,
  flushRoutingTable: flushRoutingTable,
  testRoute: testRoute
}
