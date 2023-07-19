/*    Copyright 2023 Firewalla Inc.
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

const process = require('process')
process.chdir(__dirname + "/../")

const log = require('../net2/logger.js')(__filename);
log.setGlobalLogLevel('warn')

const config = require('../net2/config')
const HostManager = require('../net2/HostManager')
const hostManager = new HostManager();
const rclient = require('../util/redis_manager.js').getRedisClient();

const moment = require('moment');

function fmtNumber(n) {
  return Math.round(n /1000 /1000).toString()
}

(async () => {
  await config.getConfig(true)
  const { download, upload, totalDownload, totalUpload, monthlyBeginTs } = await hostManager.monthlyDataStats();
  console.log(`Month Begins at: ${moment(monthlyBeginTs*1000).format('YYYY-MM-DD HH:mm:ss')}`)
  console.log(`Total: ${fmtNumber(totalDownload+totalUpload)}\t\t`
    + `Download: ${fmtNumber(totalDownload)}\t\tUpload: ${fmtNumber(totalUpload)}`)
  for (const i in download) {
    const date = moment(download[i][0]*1000).format('MM/DD')
    const total = fmtNumber(download[i][1] + upload[i][1])
    const down = fmtNumber(download[i][1])
    const up   = fmtNumber(upload[i][1])
    console.log(`\t${date}: ${total} MB\t\t${down}/${up}`)
  }

  console.log(' ================== Monthly ==================')

  // works till 2033 -.-
  const keys = await rclient.scanResults("monthly:data:usage:1*")
  for (const key of keys.sort()) {
    const record = JSON.parse(await rclient.getAsync(key))
    const date = moment(record.ts).format('MM/DD')
    const total = fmtNumber(record.stats.totalDownload + record.stats.totalUpload)
    const down = fmtNumber(record.stats.totalDownload)
    const up   = fmtNumber(record.stats.totalUpload)
    console.log(`\t${date}: ${total} MB\t\t${down}/${up}`)
  }

  process.exit(0)
})().catch(err => {
  console.error(err)
})
