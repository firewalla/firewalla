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

'use strict'

process.title = "FWBroadcastBooting";

const bonjour = require('../vendor_lib/bonjour')()
const cp = require('child_process')

const fConfig = require('../net2/config.js').getConfig(true);
const cmd = `ip addr show dev ${fConfig.monitoringInterface} | awk '/inet /' | awk '$NF==\"${fConfig.monitoringInterface}\" {print $2}' | cut -f1 -d/ | head -n 1`
const ip = cp.execSync(cmd).toString().replace(/\n$/, '')

const cmd3 = "redis-cli hget sys:ept gid"
const gid = cp.execSync(cmd3).toString().replace(/\n$/, '')

function exitBooting() {
  bonjour.unpublishAll((err) => {
    process.exit(0)
  })
}

/*
        const cmd2 = "pgrep FireKick"
        const cnt = cp.execSync(cmd2).toString().replace(/\n$/, '')
function checkBinding() {

        if(cnt != "" && cnt > 1) {
                exitBooting()
        }
}
*/


let txt = {
  ip: ip,
  exp: Math.floor(new Date() / 1000) + 5 * 60
}

if (gid && gid != "") {
  txt.gid = gid
}

// advertise an HTTP server on port 3000
bonjour.publish({
  name: 'Firewalla Booting' + Math.floor(Math.random() * 1000),
  type: 'http',
  port: 18833,
  txt: txt
}).on('error', (err) => log.error("Error publish booting bonjour", err));


/*
setInterval(() => {
        checkBinding()
}, 10 * 1000)
*/

setTimeout(() => {
  exitBooting()
}, 15 * 60 * 1000)
