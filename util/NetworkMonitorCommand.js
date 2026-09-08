/*    Copyright 2016-2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3.
 */

'use strict';

const { execFile } = require('child-process-promise');

async function ping(target, sampleTick, sampleCount, rtid) {
  const args = ['ping', '-i', String(sampleTick)];
  if (rtid) args.push('-m', String(rtid));
  args.push('-c', String(sampleCount), '-W', '1', '-4', '-n', String(target));
  const result = await execFile('sudo', args);
  return result.stdout.split(/\n/)
    .filter(line => /time=/.test(line) && !/DUP!/.test(line))
    .map(line => Number((line.match(/time[=<]([0-9.]+)/) || [])[1]))
    .filter(Number.isFinite);
}

async function dns(target, bindIP, sampleTick, lookupName) {
  const args = [`@${target}`];
  if (bindIP) args.push('-b', String(bindIP));
  args.push('+tries=1', `+timeout=${sampleTick}`, String(lookupName));
  const result = await execFile('dig', args);
  const match = result.stdout.match(/Query time:\s+(\d+)\s+msec/);
  return match ? Number(match[1]) : null;
}

async function http(target, bindIP) {
  const args = ['-s', '-k', '-m', '10'];
  if (bindIP) args.push('--interface', String(bindIP));
  args.push('-o', '/dev/null', '-w', '%{time_total}\n', '--', String(target));
  const result = await execFile('curl', args);
  return Number(result.stdout.trim());
}

module.exports = { ping, dns, http };
