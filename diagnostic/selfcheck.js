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

const log = require('../net2/logger.js')(__filename, "info");
const util = require('util');
const cp = require('child_process');

const execAsync = util.promisify(cp.exec);

// key is the item to check, and the value is the (async) function to retrive the result
const checkList = {
  piVersion: piVersion
}

async function check() {
  const result = {};
  await Promise.all(Object.keys(checkList).map(async item => {
    try {
      const value = await checkList[item]();
      result[item] = value;
    } catch (err) {
      log.error("Failed to get value of " + item, err);
      // add a place holder for this value
      result[item] = "ERROR";
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

module.exports = {
  check: check
};

(async () => {
  const result = await check();
  console.log(result);
})();

