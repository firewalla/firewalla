/*    Copyright 2019 Firewalla LLC
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

const log = require('./logger.js')(__filename);
const { exec, spawn } = require('child-process-promise');

const maxIpsetQueue = 158;
const ipsetInterval = 3000;

let ipsetQueue = [];
let ipsetTimerSet = false;
let ipsetProcessing = false;

async function isReferenced(ipset) {
  const listCommand = `sudo ipset list ${ipset} | grep References | cut -d ' ' -f 2`;
  const result = await exec(listCommand);
  const referenceCount = result.stdout.trim();
  return referenceCount !== "0";
}

function enqueue(ipsetCmd) {
  if (ipsetCmd != null) {
    ipsetQueue.push(ipsetCmd);
  }
  if (ipsetProcessing == false && ipsetQueue.length > 0 && (ipsetQueue.length > maxIpsetQueue || ipsetCmd == null)) {
    ipsetProcessing = true;
    let _ipsetQueue = JSON.parse(JSON.stringify(ipsetQueue));
    ipsetQueue = [];
    let child = require('child_process').spawn('sudo', ['ipset', 'restore', '-!']);
    child.stdin.setEncoding('utf-8');
    child.on('exit', (code, signal) => {
      ipsetProcessing = false;
      log.info("Control:Ipset:Processing:END", code);
      enqueue(null);
    });
    child.on('error', (code, signal) => {
      ipsetProcessing = false;
      log.info("Control:Ipset:Processing:Error", code);
      enqueue(null);
    });
    let errorOccurred = false;
    child.stderr.on('data', (data) => {
      log.error("ipset restore error: " + data);
    });
    child.stdin.on('error', (err) => {
      errorOccurred = true;
      log.error("Failed to write to stdin", err);
    });
    writeToStdin(0);
    function writeToStdin(i) {
      const stdinReady = child.stdin.write(_ipsetQueue[i] + "\n", (err) => {
        if (err) {
          errorOccurred = true;
          log.error("Failed to write to stdin", err);
        } else {
          if (i == _ipsetQueue.length - 1) {
            child.stdin.end();
          }
        }
      });
      if (!stdinReady) {
        child.stdin.once('drain', () => {
          if (i !== _ipsetQueue.length - 1 && !errorOccurred) {
            writeToStdin(i + 1);
          }
        });
      } else {
        if (i !== _ipsetQueue.length - 1 && !errorOccurred) {
          writeToStdin(i + 1);
        }
      }
    }
    log.info("Control:Ipset:Processing:Launched", _ipsetQueue.length);
  } else {
    if (ipsetTimerSet == false) {
      setTimeout(() => {
        if (ipsetQueue.length > 0) {
          log.info("Control:Ipset:Timer", ipsetQueue.length);
          enqueue(null);
        }
        ipsetTimerSet = false;
      }, ipsetInterval);
      ipsetTimerSet = true;
    }
  }
}

async function destroy(setName) {
  if (setName && !await isReferenced(setName))
    await exec(`sudo ipset destroy ${setName}`);
}

async function flush(setName) {
  if (setName)
    await exec(`sudo ipset flush ${setName}`);
}

async function create(name, type, v4 = true) {
  let options
  switch(type) {
    case 'bitmap:port':
      options = 'range 0-65535';
      break;
    case 'hash:mac':
      options = 'hashsize 128 maxelem 65536'
      break;
    default:
      let family = 'family inet';
      if (!v4) family = family + '6';
      options = family + ' hashsize 128 maxelem 65536'
  }
  const cmd = `sudo ipset create -! ${name} ${type} ${options}`
  return exec(cmd)
}

function add(name, target) {
  const cmd = `add -! ${name} ${target}`
  return exec('sudo ipset ' + cmd);
}

function del(name, target) {
  const cmd = `del -! ${name} ${target}`
  return exec('sudo ipset ' + cmd);
}

module.exports = {
  enqueue,
  isReferenced,
  destroy,
  flush,
  create,
  add,
  del
}
