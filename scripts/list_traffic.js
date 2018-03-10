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

const timeSeries = require('../util/TimeSeries.js').getTimeSeries()

const program = require('commander');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

program.version('0.0.2')
  .option('--alarm [alarm]', 'alarm id to resend notification');

program.parse(process.argv)

timeSeries.getHits("download", "1minute", 11, (err, data) => {

  if(data[data.length - 1][1] == 0) {
    data = data.slice(0, 10)
  } else {
    data = data.slice(1)
  }

  data.forEach((d) => {
    console.log("download", new Date(d[0] * 1000), d[1])
  })

  timeSeries.getHits("upload", "1minute", 11, (err, data) => {
    if(data[data.length - 1][1] == 0) {
      data = data.slice(0, 10)
    } else {
      data = data.slice(1)
    }

    data.forEach((d) => {
      console.log("upload", new Date(d[0] * 1000), d[1])
    })
  })

})