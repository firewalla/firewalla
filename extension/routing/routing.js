#!/usr/bin/env node
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

const log = require("../../net2/logger.js")(__filename);

const _ = require('lodash');
const AsyncLock = require('../../vendor_lib/async-lock');
const lock = new AsyncLock();

const util = require('util');

const { exec, execFile } = require('child-process-promise');
const fsp = require('fs').promises;

const RT_TYPE_VC = "RT_TYPE_VC";
const RT_TYPE_REG = "RT_TYPE_REG";
const MASK_REG = "0x1ff";
const MASK_VC = "0xfc00";
const MASK_ALL = "0xffff";

const LOCK_RT_TABLES = "LOCK_RT_TABLES";
const LOCK_FILE = "/tmp/rt_tables.lock";

const rtIdCache = {};

// the table name is interpolated into a command line that is run by root, reject anything that is
// not a plain name so it cannot end the quoting or start a command substitution
function isValidTableName(tableName) {
  return _.isString(tableName) && tableName.length > 0 && !/[^A-Za-z0-9._:@-]/.test(tableName);
}

async function removeCustomizedRoutingTable(tableName) {
  if (!isValidTableName(tableName)) {
    log.error(`Invalid routing table name: ${tableName}`);
    throw new Error(`Invalid routing table name: ${tableName}`);
  }
  await execFile('sudo', ['flock', LOCK_FILE, 'sed', '-i', '-e',
    `/^[[:digit:]]\\+\\s\\+${tableName}$/d`, '/etc/iproute2/rt_tables']);
  delete rtIdCache[tableName];
}

async function createCustomizedRoutingTable(tableName, type = RT_TYPE_REG) {
  if (!isValidTableName(tableName)) {
    log.error(`Invalid routing table name: ${tableName}`);
    throw new Error(`Invalid routing table name: ${tableName}`);
  }
  if (_.has(rtIdCache, tableName))
    return rtIdCache[tableName];
  return new Promise((resolve, reject) => {
    // the outer promise settles only through done(), so a throw or a rejected await inside this body
    // leaves it pending until the lock times out — route every failure through done(err)
    lock.acquire(LOCK_RT_TABLES, async function(done) {
      // separate bits in fwmark for vpn client and regular WAN
      const bitOffset = type === RT_TYPE_VC ? 10 : 0;
      const maxTableId = type === RT_TYPE_VC ? 64 : 512;
      let content = "";
      try {
        content = await fsp.readFile('/etc/iproute2/rt_tables', 'utf8');
      } catch (err) {
        log.error("Failed to read rt_tables.", err.message);
      }
      const usedTid = [];
      for (const entry of content.split('\n')) {
        // a comment can follow an entry, so drop the whole line if it holds a '#' at all, then
        // take the id and the name from the first two fields
        if (entry.includes('#')) continue;
        const line = entry.trim().split(/\s+/);
        const tid = line[0];
        const name = line[1];
        if (!tid) continue;
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
      // the redirections and the pipeline need a shell, so flock is given bash directly instead of
      // being wrapped in one. bash is named rather than using flock's own -c, which picks $SHELL
      // and falls back to /bin/sh, where the builtin echo has no -e and would emit a literal "-e"
      const script = `echo -e "${id << bitOffset}\\t${tableName}" >> /etc/iproute2/rt_tables; \
        cat /etc/iproute2/rt_tables | sort | uniq > /etc/iproute2/rt_tables.new; \
        cp /etc/iproute2/rt_tables.new /etc/iproute2/rt_tables; \
        rm /etc/iproute2/rt_tables.new`;
      log.info("Append new routing table: ", script);
      const result = await execFile('sudo', ['flock', LOCK_FILE, 'bash', '-c', script]);
      if (result.stderr !== "") {
        log.error("Failed to create customized routing table.", result.stderr);
        done(result.stderr, null);
        return;
      }
      done(null, id << bitOffset);
    }, function(err, ret) {
      if (err)
        reject(err);
      else {
        rtIdCache[tableName] = ret;
        resolve(ret);
      }
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

async function flushRoutingTable(tableName, dev = null, proto="boot", af = null, type = null) {
  const cmds = [];
  if (type) {
    // flush by route type (e.g. "throw", "unreachable"); dev and proto are irrelevant in this mode
    if (af === 4 || af === null) {
      cmds.push(`sudo ip route flush type ${type} table ${tableName}`);
    }
    if (af === 6 || af === null) {
      cmds.push(`sudo ip -6 route flush type ${type} table ${tableName}`);
    }
  } else {
    if (af === 4 || af === null) {
      cmds.push(`sudo ip route flush ${dev ? `dev ${dev}` : "" } proto ${proto} table ${tableName}`);
    }
    if (af === 6 || af === null) {
      cmds.push(`sudo ip -6 route flush ${dev ? `dev ${dev}` : ""} proto ${proto} table ${tableName}`);
    }
  }

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

async function addMultiPathRouteToTable(dest, tableName, af = 4, metric, ...multipathDesc) {
  let cmd = null;
  dest = dest || "default";
  cmd =  `sudo ip -${af} route add ${dest}`;
  tableName = tableName || "main";
  cmd = `${cmd} table ${tableName} metric ${metric}`;
  for (let desc of multipathDesc) {
    const nextHop = desc.nextHop;
    const dev = desc.dev;
    const weight = desc.weight;
    if (!dev || !weight)
      continue;
    cmd = `${cmd} nexthop ${nextHop ? `via ${nextHop}` : ""}`;
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
  isValidTableName,
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
