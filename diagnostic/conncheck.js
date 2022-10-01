/*    Copyright 2019-2022 Firewalla Inc.
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
const readline = require('readline');
const Config = require('../net2/config.js');

const cp = require('child-process-promise');

const availableTestDomains = [
  "github.com",
  "bing.com",
  "cisco.com"
];

const testRecords = {};

const hardTimeout = 30;

async function getDestToCheck() {
  for (let i in availableTestDomains) {
    const testDomain = availableTestDomains[i];
    let cmd = `dig -4 +short +time=3 +tries=2 ${testDomain}`;
    try {
      const result = await cp.exec(cmd);
      const ips = result.stdout.split('\n').filter(ip => ip.length !== 0);
      for (let j in ips) {
        const ip = ips[j];
        cmd = `nc -w 5 -z ${ip} 443`;
        await cp.exec(cmd);
        // connection attempt succeeded, return this ip as dst ip
        return {
          ip: ip,
          port: 443
        };
      }
    } catch (err) {
      log.info("Failed to get ip address of " + testDomain, err);
    }
  }

  // fallback, return google dns 
  return {
    ip: "8.8.8.8",
    port: 53
  };
}

async function startConnCheck(src, dst, duration) {
  if (!dst.ip || !dst.port || !src.ip) {
    return -1;
  }
  if (!duration || duration <= 0)
    duration = hardTimeout;
  if (duration > 60)
    duration = 60; // test lasts at most 1 minute
  const config = await Config.getConfig(true);
  const srcIp = src.ip;
  const dstIp = dst.ip;
  const dstPort = dst.port;
  // src->dst with SYN flag, or dst->src with SYN-ACK flag
  const tcpdumpSpawn = cp.spawn('sudo', ['timeout', duration, 'tcpdump', '-i', config.monitoringInterface, '-en', `port ${dstPort} && ((src ${srcIp} && dst ${dstIp} && tcp[13] & 2 != 0) || (src ${dstIp} && dst ${srcIp} && tcp[13] & 18 != 0))`]);
  tcpdumpSpawn.catch((err) => {}); // killed by timeout
  const tcpdump = tcpdumpSpawn.childProcess;
  const pid = tcpdump.pid;
  const testRecord = {
    running: true,
    flows: {}
  };
  testRecords[pid] = testRecord;

  const reader = readline.createInterface({
    input: tcpdump.stdout
  });
  reader.on('line', (line) => {
    if (line) {
      parseFlow(line, testRecord.flows);
    }
  });

  tcpdump.on('close', (code) => {
    log.info(`Connectivity test ${pid} ended.`);
    if (testRecord.running) {
      testRecord.running = false;
    }
    setTimeout(() => {
      delete testRecords[pid];
    }, 300000); // auto delete test record in 5 minutes
  })
  return pid;
}

async function getConnCheckResult(pid) {
  if (!pid || !testRecords[pid]) {
    return null;
  }
  const testRecord = testRecords[pid];
  const flags = Object.values(testRecord.flows);
  const bidirection = flags.filter((flag) => flag.includes("SYN") && flag.includes("SYN-ACK")).length;
  const outgoingOnly = flags.filter((flag) => flag.includes("SYN") && !flag.includes("SYN-ACK")).length;
  const incomingOnly = flags.filter((flag) => !flag.includes("SYN") && flag.includes("SYN-ACK")).length;
  return {
    bidirection: bidirection,
    outgoingOnly: outgoingOnly,
    incomingOnly: incomingOnly
  };
}

function parseFlow(line, flow) {
  /* output samples:
  19:29:26.077981 88:e9:fe:86:ff:94 > 02:01:22:96:6f:16, ethertype IPv4 (0x0800), length 78: 192.168.7.128.63903 > 52.42.237.194.443: Flags [S], seq 3385851135, win 65535, options [mss 1460,nop,wscale 5,nop,nop,TS val 1262682038 ecr 0,sackOK,eol], length 0
  19:29:26.079965 02:01:22:96:6f:16 > 88:e9:fe:86:ff:94, ethertype IPv4 (0x0800), length 74: 52.42.237.194.443 > 192.168.7.128.63903: Flags [S.], seq 2642502853, ack 3385851136, win 28960, options [mss 1460,sackOK,TS val 2717994924 ecr 1262682038,nop,wscale 7], length 0
  */
  try {
    const tuples = line.split(', ')[2].split(' '); // tuples is like ['length', '78:', '192.168.7.128.63903', '>', '52.42.237.194.443:', 'Flags', '[S]']
    const flag = tuples[tuples.length - 1];
    if (flag.includes('S') && !flag.includes('.')) { // only SYN is set
      const srcPort = tuples[2].substring(tuples[2].lastIndexOf('.') + 1);
      if (srcPort && !flow[srcPort]) {
        // a new flow is initiated
        flow[srcPort] = ["SYN"];
      }
    }
    if (flag.includes('S') && flag.includes('.')) { // SYN + ACK is set
      const srcPort = tuples[4].substring(tuples[4].lastIndexOf('.') + 1, tuples[4].length - 1);
      if (srcPort && flow[srcPort] && Array.isArray(flow[srcPort]) && !flow[srcPort].includes("SYN-ACK")) {
        flow[srcPort].push("SYN-ACK");
      }
    }
  } catch (err) {
    log.warn("Failed to parse line: " + line, err);
  }
}

module.exports = {
  getDestToCheck: getDestToCheck,
  startConnCheck: startConnCheck,
  getConnCheckResult: getConnCheckResult
}
