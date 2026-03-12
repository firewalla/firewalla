/*    Copyright 2019-2026 Firewalla Inc.
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
const LRU = require('lru-cache');
const throttling = new LRU({max: 1000, maxAge: 60 * 1000});
const rateLimiting = new LRU({max: 100, maxAge: 7200 * 1000});

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

const exponentialBackoff = [ 10, 60, 300, 1800, 7200 ]; // 2hrs at maximum

async function rrWithErrHandling(options, usePool = false, compress = false, throttle = false) {
  const uri = options.uri && (typeof options.uri === 'object' ? options.uri.href : options.uri);
  if (!uri) throw new Error('options.uri is required');
  const lastSlashIndex = uri.lastIndexOf('/');
  const uriKey = lastSlashIndex >= 0 ? uri.substring(0, lastSlashIndex) : uri;

  const msg = `HTTP failed after ${options.maxAttempts || 5} attempt(s) ${options.method || 'GET'} ${uri}`
  const uid = uuid.v4()
  const json = Boolean(options.json)
  log.verbose(uid, options.method || 'GET', uri, usePool && 'pooled' || '', compress && 'compressed' || '', throttle && 'throttled' || '')

  // a simple and brutal throttling, hard coded 10 requests per minute
  if (throttle) {
    let throttled = throttling.get(uriKey);
    if (!throttled) {
      throttled = { count: 0 };
      throttling.set(uriKey, throttled);
    } else if (throttled.count >= 10) {
      log.verbose(`Hits throttle threshold ${uri}`);
      throw new Error(`Throttling ${uri}`);
    }

    throttled.count++;
    setTimeout(() => {
      throttled.count--
    }, 60 * 1000);
  }
  
  const rateLimited = rateLimiting.get(uriKey);
  if (rateLimited && rateLimited.wait > Date.now() / 1000) {
    log.verbose(`Rate limited until ${rateLimited.wait}, ${uri}`);
    throw new Error(`Rate limited until ${rateLimited.wait}, ${uri}`);
  }

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

  // a simple exponential backoff on 429
  if (response.statusCode == 429) {
    if (!rateLimited) {
      rateLimiting.set(uriKey, { step: 0, wait: Date.now()/1000 + exponentialBackoff[0] });
    } else if (rateLimited.step < exponentialBackoff.length - 1) {
      rateLimited.step++
      rateLimited.wait = Date.now()/1000 + exponentialBackoff[rateLimited.step];
    }
  } else
    rateLimiting.del(uriKey);

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

  if (response.body) {
    // compressed json request does not get parsed automatically
    if (compress && json && typeof response.body === 'string') try {
      response.body = JSON.parse(response.body)
    } catch (err) {
      log.error('Failed to parse response body:', err)
    }
  } else
    response.body = null

  return response
}


module.exports = {
  rrWithErrHandling
}
