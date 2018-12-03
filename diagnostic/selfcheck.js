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

const log = require('../net2/logger.js')(__filename, "info");
const util = require('util');
const cp = require('child_process');

const execAsync = util.promisify(cp.exec);

const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager();
const fConfig = require('../net2/config.js').getConfig();

const ERROR_STR = "ERROR";

// key is the item to check, and the value is the (async) function to retrive the result
const checkList = {
  piVersion: piVersion,
  ipv4Address: ipAddress,
  gateway: gateway,
  gatewayLatency: gatewayLatency,
  macAddress: macAddress,
  dns: dns,
  cloudLatency: cloudLatency,
  mode: mode
}

async function check() {
  await sysManager.setConfig(fConfig);
  const result = {};
  await Promise.all(Object.keys(checkList).map(async item => {
    try {
      const value = await checkList[item]();
      result[item] = value;
    } catch (err) {
      log.error("Failed to get value of " + item, err);
      // add a place holder for this value
      result[item] = ERROR_STR;
    }
  }));
  return result;  
}

async function piVersion() {
  let cmd = "git rev-parse --abbrev-ref HEAD";
  let result = await execAsync(cmd);
  const ref = result.stdout.replace("\n", "");
  let branch = ref;
  if (ref.match(/^beta_.*/)) {
    branch = "beta";
  }
  if (ref.match(/^release_.*/)) {
    branch = "prod";
  }

  cmd = "git describe --abbrev=0 --tags";
  result = await execAsync(cmd);
  const tag = result.stdout.replace("\n", "");
  return util.format("%s(%s)", branch, tag);
}

async function ipAddress() {
  const ip = sysManager.myIp();
  return ip;
}

async function gateway() {
  const gateway = sysManager.myGateway();
  return gateway;
}

async function gatewayLatency() {
  const gateway = sysManager.myGateway();
  if (gateway) {
    const cmd = util.format("ping -n -c 10 -i 0.2 -w 3 %s | tail -n 1 | cut -d= -f2 | cut -d/ -f2", gateway);
    const result = await execAsync(cmd);
    const latency = result.stdout.replace("\n", "") + "ms";
    return latency;
  }
  return ERROR_STR;
}

async function macAddress() {
  const mac = sysManager.myMAC();
  return mac;
}

async function dns() {
  const dns = sysManager.myDNS();
  return dns;
}

async function cloudLatency() {
  
  const cloudUrl = fConfig.firewallaGroupServerURL || "https://firewalla.encipher.io";
  const cmd = util.format("curl -w \"%{time_total}\" -o /dev/null -s \"%s\"", cloudUrl);
  const result = await execAsync(cmd);
  const latency = result.stdout + "s";
  return latency;
}

async function mode() {
  const cmd = "redis-cli get mode";
  const result = await execAsync(cmd);
  const mode = result.stdout.replace("\n", "");
  return mode;
}

module.exports = {
  check: check
};

