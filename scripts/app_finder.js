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

const util = require('util')

const rclient = require('../util/redis_manager.js').getRedisClient()

const Promise = require('bluebird')

const flowTool = require('../net2/FlowTool.js')()

const IntelTool = require('../net2/IntelTool.js')
const intelTool = new IntelTool()

program.version('0.0.1')
  .option('--ip [ip]', 'ip to list app/category activity')
  .option('--app [app]', 'app')
  .option('--category [category]', 'category')


program.parse(process.argv);

function print(flow, app, category) {
  let d = new Date(0)
  d.setUTCSeconds(flow.ts)
 
  log.info(d, app, category, flow.sh, flow.dh, flow.ob, flow.rb, {})
}

if(program.ip) {
  let ip = program.ip

  async(() => {

    let key = util.format("flow:conn:%s:%s", 'in', ip);

    let flows = await (rclient.zrangebyscoreAsync(key, 0, -1))

    for(let i in flows) {
      let flowJSON = flows[i]
      let flow = JSON.parse(flowJSON)

      let srcIP = flow.sh
      let destIP = flow.dh

      let intel = await (intelTool.getIntel(ip))

      if(program.app && intel.app === program.app) {
        print(flow, program.app, null)
      }

      if(program.category && intel.category === program.category) {
        print(flow, null, program.category)
      }
    }
  })()
} else {
  process.exit(0)
}
