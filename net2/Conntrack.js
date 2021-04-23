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
const sysManager = require('./SysManager.js')
const sem = require('../sensor/SensorEventManager.js').getInstance();

const { spawn } = require('child_process');
const readline = require('readline');

const LRU = require('lru-cache');
const { Address6 } = require('ip-address');

const FEATURE_NAME = 'conntrack'

class Conntrack {
  constructor() {
    this.config = features.getConfig(FEATURE_NAME)
    if (!this.config.enabled) return

    this.entries = {}
    this.scheduledJob = {}

    log.info('Feature enabled');
    for (const protocol in this.config) {
      if (!protocol || protocol == 'enabled') continue

      const { maxEntries, maxAge, interval, timeout } = this.config[protocol]
      // most gets will miss, LRU might not be the best choice here
      this.entries[protocol] = new LRU({max: maxEntries, maxAge: maxAge * 1000, updateAgeOnGet: false});
      this.scheduledJob[protocol] = setInterval(this.fetchData.bind(this), interval * 1000, protocol, timeout)
    }

    // for debug
    sem.on('Conntrack', message => {
      log.debug(this.entries[message.protocol][message.api](... message.args))
    })
  }

  fetchData(protocol, timeout) {
    if (!this.config.enabled || !this.config[protocol]) return

    const family = {4: 'ipv4', 6: 'ipv6'}
    for (const ver in family) {
      const cp = spawn('sudo', ['conntrack', '-L', '-p', protocol, '-f', family[ver]])
      const rl = readline.createInterface({input: cp.stdout});
      setTimeout(() => {
        rl.close();
        cp.kill();
      }, timeout * 1000);
      rl.on('line', line => {
        try {
          const conn = {}
          let i = 0
          for (const param of line.split(' ').filter(Boolean)) {
            if (i++ < 3) continue

            const kv = param.split('=')
            // the first group of src/dst indicates the connection direction
            if (kv.length != 2 || !kv[0] || !kv[1] || conn[kv[0]]) continue

            switch (kv[0]) {
              case 'src':
                // only record outbound connections for TCP
                if (protocol == 'tcp' && !sysManager.isLocalIP(kv[1])) continue;
              // falls through
              case 'dst':
                if (ver == 6) {
                  kv[1] = new Address6(kv[1]).correctForm()
                }
                conn[kv[0]] = kv[1]
                break;
              case 'sport':
              case 'dport':
                conn[kv[0]] = kv[1]
                break;
              default:
            }
          }

          // record both src/dst for UDP as it's used for block matching on FORWARD chain
          // record only dst for TCP as it's used for WAN block matching on INPUT chain
          //    src port is NATed and we cannot rely on conntrack sololy for this. remotes from zeek logs are added as well
          //
          // note that v6 address is canonicalized here, e.g 2607:f8b0:4005:801::2001
          this.entries[protocol].set(
            protocol == 'tcp' ?
              `${conn.dst}:${conn.dport}` :
              `${conn.src}:${conn.sport}:${conn.dst}:${conn.dport}`
            ,
            true
          )
        } catch (err) {
          log.error(`Failed to process ${family} ${protocol} data`, err, line)
        }
      })
    }
  }

  has(protocol, descriptor) {
    if (!this.entries[protocol]) return undefined

    return this.entries[protocol].get(descriptor);
  }

  set(protocol, descriptor) {
    if (!this.entries[protocol]) return

    this.entries[protocol].set(descriptor, true);
  }
}

module.exports = new Conntrack();
