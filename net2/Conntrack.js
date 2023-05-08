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
    this.connHooks = {};
    this.connCache = {};

    log.info('Feature enabled');
    for (const protocol in this.config) {
      if (!protocol || protocol == 'enabled') continue

      const { maxEntries, maxAge, interval, timeout, event } = this.config[protocol]
      // most gets will miss, LRU might not be the best choice here
      this.entries[protocol] = new LRU({max: maxEntries, maxAge: maxAge * 1000, updateAgeOnGet: false});

      this.spawnProcess(protocol, event).catch((err) => {
        log.error(`Failed to spawn conntrack on ${protocol}`, err.message);
      });
    }

    // for debug
    sem.on('Conntrack', message => {
      log.debug(this.entries[message.protocol][message.api](... message.args))
    })
  }

  async spawnProcess(protocol, event = "NEW,DESTROY", src, dst, sport, dport, onNew, onDestroy) {
    const cmdlines = ['conntrack', '-E', '-e', event, '-p', protocol, '-b', '8088608'];
    if (src)
      Array.prototype.push.apply(cmdlines, ['-s', src]);
    if (dst)
      Array.prototype.push.apply(cmdlines, ['-d', dst]);
    if (sport)
      Array.prototype.push.apply(cmdlines, ['--sport', sport]);
    if (dport)
      Array.prototype.push.apply(cmdlines, ['--dport', dport]);
    const conntrackProc = spawn('sudo', cmdlines);
    const reader = readline.createInterface({
      input: conntrackProc.stdout
    });
    conntrackProc.on('exit', (code, signal) => {
      log.info(`conntrack of ${protocol} is terminated and the exit code is ${code}, will be restarted soon`);
      setTimeout(() => {
        this.spawnProcess(protocol, event, src, dst, sport, dport, onNew, onDestroy).catch((err) => {
          log.error(`Failed to spawn conntrack on ${protocol}`, err.message);
        });
      }, 3000);
    })
    reader.on('line', (line) => {
      this.processLine(protocol, line, onNew, onDestroy).catch((err) => {
        log.error(`Failed to process conntrack line: ${line}`, err.message);
      });
    });
  }

  async processLine(protocol, line, onNew, onDestroy) {
    if (!this.config.enabled || !this.config[protocol]) return    
    try {
      const conn = {protocol}
      let event = null;
      let i = 0
      for (const param of line.split(' ').filter(Boolean)) {
        if (i === 0) {
          // [NEW] or [DESTROY]
          event = param;
        }
        if (param === "CLOSE" || param === "TIME_WAIT") {
          // connection state
          conn.state = param;
        }
        i++;
        const kv = param.split('=')
        // the first group of src/dst indicates the connection direction
        if (kv.length != 2 || !kv[0] || !kv[1]) continue

        switch (kv[0]) {
          case 'src':
          case 'dst':
            if (conn[kv[0]])
              continue;
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
            if (conn[kv[0]])
              continue;
            conn[kv[0]] = Number(kv[1])
            break;
          case 'packets':
            if (conn.hasOwnProperty("origPackets"))
              conn["respPackets"] = Number(kv[1]);
            else
              conn["origPackets"] = Number(kv[1]);
            break;
          case 'bytes':
            if (conn.hasOwnProperty("origBytes"))
              conn["respBytes"] = Number(kv[1]);
            else
              conn["origBytes"] = Number(kv[1]);
            break;
          default:
        }
      }

      if (!onNew && !onDestroy) {
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
      } else {
        switch (event) {
          case "[NEW]":
            onNew(conn);
            break;
          case "[DESTROY]":
            onDestroy(conn);
            break;
          default:
        }
      }
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

  getConnStr(connDesc) {
    return `${connDesc.src || "*"}::${connDesc.sport || "*"}::${connDesc.dst || "*"}::${connDesc.dport || "*"}::${connDesc.protocol || "*"}`
  }

  registerConnHook(connDesc, func) {
    const key = this.getConnStr(connDesc);
    if (!this.connHooks[key]) {
      this.spawnProcess(connDesc.protocol || "tcp", "NEW,DESTROY", connDesc.src, connDesc.dst, connDesc.sport, connDesc.dport,
        (connInfo) => {
          this.connCache[this.getConnStr(connInfo)] = { begin: Date.now() / 1000 };
        },
        (connInfo) => {
          const connStr = this.getConnStr(connInfo);
          if (this.connCache[connStr]) {
            connInfo.duration = Date.now() / 1000 - this.connCache[connStr].begin;
            switch (connInfo.state) {
              case "TIME_WAIT":
                if (connInfo.duration > 120)
                  connInfo.duration -= 120; // nf_conntrack_tcp_timeout_time_wait = 120
                break;
              case "CLOSE":
              default:
                if (connInfo.duration > 10)
                  connInfo.duration -= 10; // nf_conntrack_tcp_timeout_close
                break;
            }
            const func = this.connHooks[key];
            // func can be updated over the run
            if (typeof func === 'function')
              func(connInfo);
            delete this.connCache[connStr];
          }
        }
      );
    }
    this.connHooks[key] = func;
  }
}

module.exports = new Conntrack();
