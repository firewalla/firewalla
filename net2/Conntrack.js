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
const platform = require('../platform/PlatformLoader.js').getPlatform();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const spawn = require('child_process').spawn;

const readline = require('readline');

const LRU = require('lru-cache');
const { Address6 } = require('ip-address');
const f = require('./Firewalla.js');

const FEATURE_NAME = 'conntrack'

class Conntrack {
  constructor() {
    this.config = features.getConfig(FEATURE_NAME)
    if (!this.config.enabled || !platform.isAuditLogSupported()) return
    if (!f.isMain())
      return;

    this.entries = {}
    this.scheduledJob = {}

    log.info('Feature enabled');
    for (const protocol in this.config) {
      if (!protocol || protocol == 'enabled') continue

      const { maxEntries, maxAge, interval, timeout } = this.config[protocol]
      // most gets will miss, LRU might not be the best choice here
      this.entries[protocol] = new LRU({max: maxEntries, maxAge: maxAge * 1000, updateAgeOnGet: false});

      this.spawnProcess(protocol).catch((err) => {
        log.error(`Failed to spawn conntrack on ${protocol}`, err.message);
      });
    }

    // for debug
    sem.on('Conntrack', message => {
      log.debug(this.entries[message.protocol][message.api](... message.args))
    })
  }

  async spawnProcess(protocol) {
    const conntrackProc = spawn('sudo', ['conntrack', '-E', '-e', 'NEW,DESTROY', '-p', protocol, '-b', '8088608']);
    const reader = readline.createInterface({
      input: conntrackProc.stdout
    });
    conntrackProc.on('exit', (code, signal) => {
      log.info(`conntrack of ${protocol} is terminated and the exit code is ${code}, will be restarted soon`);
      setTimeout(() => {
        this.spawnProcess(protocol).catch((err) => {
          log.error(`Failed to spawn conntrack on ${protocol}`, err.message);
        });
      }, 3000);
    })
    reader.on('line', (line) => {
      this.processLine(protocol, line).catch((err) => {
        log.error(`Failed to process conntrack line: ${line}`, err.message);
      });
    });
  }

  async processLine(protocol, line) {
    if (!this.config.enabled || !this.config[protocol]) return    
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
          case 'dst':
            if (kv[1] === "127.0.0.1" || kv[1] === "::1")
                return;
            if (kv[1].includes(":")) {
              if (kv[1].startsWith("ff:")) // ff00::/8 is IPv6 multicast address range
                return;
              kv[1] = new Address6(kv[1]).correctForm()
            } else {
              const mS8B = kv[1].split(".")[0];
              if (!isNaN(mS8B) && Number(mS8B) >= 224 && Number(mS8B) <= 239) // ipv4 multicast address
                return;
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
      const descriptor = Buffer.from(protocol == 'tcp' ?
        `${conn.dst}:${conn.dport}` :
        `${conn.src}:${conn.sport}:${conn.dst}:${conn.dport}`
      ).toString(); // Force flatting the string, https://github.com/nodejs/help/issues/711
      this.entries[protocol].set(descriptor, true)
    } catch (err) {
      log.error(`Failed to process ${protocol} data ${line}`, err.toString())
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
