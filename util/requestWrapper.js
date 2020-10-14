/*    Copyright 2019-2020 Firewalla Inc.
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
const log = require('../net2/logger.js')(__filename);
const rr = require('requestretry').defaults({ timeout: 30000 });

async function rrWithErrHandling(options) {
  const msg = `HTTP failed after ${options.maxAttempts || 5} attempt(s) ${options.method || 'GET'} ${options.uri}`

  options.fullResponse = true

  const response = await rr(options).catch(err => {
    err.message = msg + '\n' + err.message
    err.stack = msg + '\n' + err.stack
    throw err
  })

  if (response.statusCode < 200 || response.statusCode > 299) {
    const respSummary = response.statusCode + ': ' + JSON.stringify(response.body)
    const error = new Error(msg + `\n` + respSummary)
    error.statusCode = response.statusCode
    error.body = response.body

    log.debug(msg)
    log.debug(JSON.stringify(options.body || options.json))
    log.debug(respSummary)

    throw error
  }

  if (!response.body) response.body = null

  return response
}



module.exports = {
  rrWithErrHandling
}
