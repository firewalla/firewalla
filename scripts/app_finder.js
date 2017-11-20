/*    Copyright 2016 Firewalla LLC 
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

const log = require('../net2/logger.js')(__filename)

const program = require('commander');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const flowTool = require('../net2/FlowTool.js')()

program.version('0.0.1')
  .option('--ip [ip]', 'ip to list app/category activity');

program.parse(process.argv);

if(program.ip) {
  let ip = program.ip

  async(() => {
    
    let flows = await (flowTool.getRecentOutgoingConnections(ip, {
      maxRecentFlow: 10000
    }))

    console.log(flows)

  })()
} else {
  process.exit(0)
}
