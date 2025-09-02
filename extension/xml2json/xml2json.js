/*    Copyright 2025 Firewalla Inc.
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

/*
 * This app will provide API for external calls
 */
'use strict';

const cp = require('child_process');
const log = require('../../net2/logger')(__filename)
const Firewalla = require('../../net2/Firewalla.js');
const xml2jsonBinary = Firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + Firewalla.getPlatform();
const { buildDeferred } = require('../../util/asyncNative.js')

async function parse(str, options = {}) {
  log.verbose('parse', options)
  const xml2json = cp.spawn(xml2jsonBinary)
  const buffers = []
  const deferred = buildDeferred()

  // goxml2json doesn't really throw, but return empty string instead
  xml2json.on('error', err => {
    xml2json.kill()
    deferred.reject(err)
  })
  xml2json.stdout.on('data', data => buffers.push(data))
  xml2json.stdout.on('close', () => {
    xml2json.kill()
    try {
      const result = JSON.parse(Buffer.concat(buffers).toString())
      if (!result instanceof Object) {
        deferred.reject(new Error('Invalid Result'))
      }

      if (options.root === false && Object.keys(result)) {
        deferred.resolve(result[Object.keys(result)[0]])
      } else {
        deferred.resolve(result)
      }
    } catch(err) {
      deferred.reject(err)
    }
  })

  xml2json.stdin.write(str)
  xml2json.stdin.end()

  return deferred.promise
}

module.exports = {
  parse,
}
