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

program.version('0.0.1')
  .option('--event [event]', 'event')
  .option('--message [message]', 'message')

program.parse(process.argv);

if(!program.event || !program.message) {
  console.log("parameters event and message are required");
  process.exit(1);
}

(async () => {
  await sysManager.waitTillInitialized()
  await fwDiag.submitInfo({
    event: program.event,
    msg: program.message
  });
  process.exit(0);
})();
