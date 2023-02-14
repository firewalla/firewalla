#!/usr/bin/env node

/*    Copyright 2016-2022 Firewalla Inc.
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

const flowTool = require('../net2/FlowTool.js')

const program = require('commander');

program.version('0.0.2')
  .option('--mac [mac]', 'mac address')
  .option('--filter [filter]', 'filter on host')

program.parse(process.argv)

const mac = program.mac

if(!mac) {
  process.exit(1)
}

(async() =>{
  let conns = await flowTool.prepareRecentFlows({}, {
    mac,
    end: new Date() / 1000,
    begin: new Date() / 1000 - 86400,
    direction: "in",
  })

  conns = conns.sort((a, b) => a.ts - b.ts)

  conns.map((conn) =>  {

    if(program.filter) {
      if(!conn.host.match(new RegExp(program.filter))) {
        return
      }
    }
    console.log(`${Math.floor(conn.ts / 60 / 5)}\t${conn.ts}\t${conn.host}\t${conn.ip}\t${conn.upload}\t${conn.download}\t${conn.category}\t${conn.duration}`)
  })

})()
