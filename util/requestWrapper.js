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
const https = require('https');
const requestretry = require('requestretry');
const zlib = require('zlib');
const util = require('util');

// Promisify zlib.gzip
const gzipAsync = util.promisify(zlib.gzip);


const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 20000, maxSockets: 1, timeout: 55000, });
const rrPooled = requestretry.defaults({ agent: agent });
const rr = requestretry.defaults({ timeout: 30000 });

const uuid = require('uuid')

const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('../net2/Message.js');

sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
  log.info("Network change, reset pooled agent");
  agent.destroy();
})

async function rrWithErrHandling(options, usePool = false, compress = false) {
  const msg = `HTTP failed after ${options.maxAttempts || 5} attempt(s) ${options.method || 'GET'} ${options.uri}`
  const uid = uuid.v4()
  log.verbose(uid, options.method || 'GET', options.uri)

  options.fullResponse = true

  // Handle compression if requested
  if (compress && (options.body || options.json)) {
    try {
      let payload;
      if (options.json) {
        payload = JSON.stringify(options.json);
      } else if (options.body) {
        payload = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }

      if (payload) {
        const compressedPayload = await gzipAsync(payload)

        options.body = compressedPayload;
        options.headers = options.headers || {};
        options.headers['Content-Encoding'] = 'gzip';
        if (options.json) {
          delete options.json;
          options.headers['Content-Type'] = 'application/json';
        }
        options.gzip = true;
      }
    } catch (err) {
      log.error(uid, 'Failed to compress payload:', err.message);
    }
  }

  let response
  try {
    if (usePool === true) {
      response = await rrPooled(options);
    } else {
      response = await rr(options)
    }
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

    log.verbose(uid, msg)
    log.debug(JSON.stringify(options.body || options.json))
    log.verbose(respSummary)

    throw error
  }

  if (!response.body) response.body = null

  return response
}


module.exports = {
  rrWithErrHandling
}
