/*    Copyright 2019-2020 Firewalla INC
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
'use strict'

const fwDiag = require("../extension/install/diag.js");
const program = require('commander');
const sysManager = require('../net2/SysManager.js');

program.version('1.0.0')
  .option('--data <data>', 'json data to send, string will send as { msg }')
  .option('--level <level>', 'log level', 'info')

program.parse(process.argv);

console.log(program.level)
console.log(program.data)

if (!program.data) {
  console.log("parameter data is required");
  process.exit(1);
}

(async () => {
  var json
  try {
    json = JSON.parse(program.data)
  } catch(e) {
    json = { msg: program.data }
  }

  await sysManager.waitTillInitialized()
  await fwDiag.log(program.level, json);
  process.exit(0);
})().catch(err => {
  console.log('Error sending log', err);
  process.exit(1);
})
