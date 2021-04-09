/*    Copyright 2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program. If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require('./logger.js')(__filename);
const features = require('./features.js')

const { exec } = require('child-process-promise');
const LRU = require('lru-cache');

const FEATURE_NAME = 'conntrack'

class Conntrack {
  constructor() {
    this.config = features.getConfig(FEATURE_NAME)
    // LRU might not the best choice here
    this.entries = new LRU({max: this.config.maxEntries, maxAge: this.config.maxAge * 1000});
    this.scheduledJob = setInterval(this.fetchData.bind(this), this.config.interval * 1000)
  }

  async fetchData() {
    if (!features.isOn(FEATURE_NAME)) return
    try {
      // Only get udp data for now
      const result = await exec(`sudo conntrack -L -p udp`)
      result.stdout.split('\n').map(line => {
        const conn = {}
        let i = 0
        for (const param of line.split(' ').filter(Boolean)) {
          if (i++ < 3) continue

          const kv = param.split('=')
          // the first group of src/dst indicates the connection direction
          if (kv.length != 2 || conn[kv[0]]) continue

          switch (kv[0]) {
            case 'src':
            case 'dst':
            case 'sport':
            case 'dport':
              conn[kv[0]] = kv[1]
              break;
            default:
          }
        }

        this.entries.set(`${conn.src}:${conn.sport}:${conn.dst}:${conn.dport}`, true)
      })

    } catch(err) {
      log.error('Failed to fetch data', err)
    }
  }

  // has(descriptor) {
  //   const params = descriptor.split(':')
  //   if (params.length != 4) return undefined
  //   const [src,sport,dst,dport] = params

  //   return this.entries.has(descriptor) || this.entries.has(`${dst}:${dport}:${src}:${sport}`)
  // }

  has(descriptor) {
    return this.entries.has(descriptor);
  }
}

module.exports = new Conntrack();
