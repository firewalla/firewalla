/*    Copyright 2019-2022 Firewalla Inc.
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
const uuid = require('uuid')

async function rrWithErrHandling(options) {
  const msg = `HTTP failed after ${options.maxAttempts || 5} attempt(s) ${options.method || 'GET'} ${options.uri}`
  const uid = uuid.v4()
  log.debug(msg, uid, new Error().stack)

  options.fullResponse = true

  let response
  try {
    response = await rr(options)
  } catch(err) {
    log.debug(uid, err)
    const error = new Error(msg + `\n` + err.message)
    throw error
  }

  if (response.statusCode < 200 || response.statusCode > 299) {
    const respSummary = response.statusCode + ': ' + JSON.stringify(response.body)
    const error = new Error(msg + `\n` + respSummary)
    error.statusCode = response.statusCode
    error.body = response.body

    log.debug(uid, msg)
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
