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

const rclient = require('../util/redis_manager.js').getRedisClient()

const program = require('commander');

program.version('0.0.2')
  .option('--srcKey [source]', 'source hash key')
  .option('--dstKey [destination]', 'destination hash key')

program.parse(process.argv);

const srcKey = program.source
const destKey = program.destination

if(!srcKey || !destKey) {
  program.help()
  return
}

(async() =>{
  let data = await rclient.hgetallAsync(srcKey)
  await rclient.hmsetAsync(destKey, data)
  process.exit(0)
})()


