/*    Copyright 2021 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename)

const Sensor = require('./Sensor.js').Sensor
const extensionManager = require('./ExtensionManager.js')
const fireRouter = require('../net2/FireRouter.js')
const delay = require('../util/util.js').delay;
const flowTool = require('../net2/FlowTool');
const sysManager = require('../net2/SysManager.js');
const platform = require('../platform/PlatformLoader.js').getPlatform()
const Host = require('../net2/Host')
const HostManager = require('../net2/HostManager.js')
const hostManager = new HostManager()
const Identity = require('../net2/Identity')
const identityManager = require('../net2/IdentityManager');
const sem = require('./SensorEventManager.js').getInstance();

const Promise = require('bluebird');
const fs = require('fs');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const { spawn } = require('child_process')
const _ = require('lodash')

const unitConvention = { KB: 1024, MB: 1024*1024, GB: 1024*1024*1024, TB: 1024*1024*1024*1024 };

class LiveStatsPlugin extends Sensor {
  registerStreaming(data) {
    const { streaming, target, type, queries } = data;
    const id = streaming.id
    if (! (id in this.streamingCache)) {
      this.streamingCache[id] = { target, type, queries }
    }

    return this.streamingCache[id]
  }

  resetThroughputCache(cache) {
    if (cache.iftop) {
      cache.iftop.stdout.unpipe()
      // iftop is invoked as root
      exec(`sudo pkill -P ${cache.iftop.pid}`).catch(() => {})
      delete cache.iftop
    }
    if (cache.egrep) {
      cache.egrep.kill()
      delete cache.egrep
    }
    if (cache.rl) {
      cache.rl.close()
      delete cache.rl
    }
  }

  cleanupStreaming() {
    for (const id in this.streamingCache) {
      const cache = this.streamingCache[id];
      if (cache.ts < Math.floor(new Date() / 1000) - (this.config.cacheTimeout || 30)) {
        log.verbose('Cleaning cache for', cache.target || id)
        this.resetThroughputCache(cache)
        if (cache.interval) clearInterval(cache.interval)
        delete this.streamingCache[id]
      }
    }
  }

  lastFlowTS(flows) { // flows must be in asc order
    if (flows.length == 0) {
      return 0;
    }
    return flows[flows.length-1].ts;
  }

  async apiRun() {
    this.activeConnCount = await this.getActiveConnections();
    this.streamingCache = {};

    sem.on('LiveStatsPlugin', message => {
      if (!message.id)
        log.verbose(Object.keys(this.streamingCache))
      else
        log.verbose(this.streamingCache[message.id])
    })

    setInterval(() => {
      this.cleanupStreaming()
    }, (this.config.cleanInterval || 30) * 1000);

    this.timer = setInterval(async () => {
      try {
        this.activeConnCount = await this.getActiveConnections();
      } catch(err) {
        log.error('Failed to get active connection count', err)
      }
    }, 300 * 1000); // every 5 mins;

    extensionManager.onGet("liveStats", async (_msg, data) => {
      const cache = this.registerStreaming(data);
      const { type, target, queries } = data
      const response = {}

      if (queries && queries.flows) {
        let lastTS = cache.flowTs;

        const now = Math.floor(new Date() / 1000);
        const flows = [];

        if(!lastTS) {
          const prevFlows = await this.getFlows(type, target, undefined, queries.flows)
          while (prevFlows.length) flows.push(prevFlows.shift())
          lastTS = this.lastFlowTS(flows) && now;
        } else {
          if (lastTS < now - 60) {
            lastTS = now - 60; // self protection, ignore very old ts
          }
        }

        const newFlows = await this.getFlows(type, target, lastTS, queries.flows);
        while (newFlows.length) flows.push(newFlows.shift())

        const newFlowTS = this.lastFlowTS(flows) || lastTS;
        cache.flowTs = newFlowTS;
        response.flows = flows
      }

      if (queries && queries.throughput) {
        switch (type) {
          case 'host': {
            if (!platform.getIftopPath()) break;
            const result = this.getDeviceThroughput(target, cache)
            response.throughput = result ? [ result ] : []
            break;
          }
          case 'intf':
          case 'system': {
            if (type == 'intf') {
              const intf = sysManager.getInterfaceViaUUID(target)
              if (!intf) {
                throw new Error(`Invalid Interface ${target}`)
              }
              response.throughput = [ { name: intf.name, target } ]
            } else {
              const interfaces = _.union(platform.getAllNicNames(), fireRouter.getLogicIntfNames())
              _.remove(interfaces, name => name.endsWith(':0') || !sysManager.getInterface(name))
              response.throughput = interfaces
                .map(name => ({ name, target: sysManager.getInterface(name).uuid }))
            }

            response.throughput.forEach(intf => Object.assign(intf, this.getIntfThroughput(intf.name)))
            break;
          }
        }
      }

      // backward compatibility, only returns intf stats
      if (!queries) {
        const intfs = fireRouter.getLogicIntfNames();
        const intfStats = [];
        const promises = intfs.map( async (intf) => {
          const rate = await this.getRate(intf);
          intfStats.push(rate);
        });
        promises.push(delay(1000)); // at least wait for 1 sec
        await Promise.all(promises);
        return { flows: [], intfStats, activeConn: 0 }
      }

      // only supports global activeConn now
      if (queries && queries.activeConn && type == 'system') {
        response.activeConn = this.activeConnCount
      }

      log.debug(response)
      return response
    });
  }

  getDeviceThroughput(target, cache) {
    if (!cache.iftop || !cache.egrep || !cache.rl) {
      log.verbose('Creating device throughput cache ...', target)
      this.resetThroughputCache(cache)

      const host = hostManager.getHostFastByMAC(target) || identityManager.getIdentityByGUID(target);
      if (!host) {
        throw new Error(`Invalid host ${target}`)
      }

      const iftopCmd = [
        'stdbuf', '-o0', '-e0',
        platform.getIftopPath(), '-c', platform.getPlatformFilesPath() + '/iftop.conf'
      ]
      if (host instanceof Host) {
        const intf = sysManager.getInterfaceViaUUID(host.o.intf)
        if (!intf) {
          throw new Error(`Invalid host interface`, target, host.o.ipv4)
        }
        iftopCmd.push('-i', intf.name, '-tB', '-f', 'ether host ' + host.o.mac)
      } else if (host instanceof Identity) {
        const intfName = host.getNicName()
        iftopCmd.push('-i', intfName, '-tB', '-f', identityManager.getIPsByGUID(target).map(ip => 'net ' + ip).join(' or '))
      } else {
        throw new Error('Unknown host type', host)
      }
      // sudo has to be the first command otherwise stdbuf won't work for privileged command
      const iftop = spawn('sudo', iftopCmd);
      log.debug(iftop.spawnargs)
      iftop.on('error', err => {
        log.error(`iftop error for ${target}`, err.toString());
      });
      const egrep = spawn('stdbuf', ['-o0', '-e0', 'egrep', 'Total (send|receive) rate:'])
      egrep.on('error', err => {
        log.error(`egrep error for ${target}`, err.toString());
      });

      iftop.stdout.pipe(egrep.stdin)

      const rl = require('readline').createInterface(egrep.stdout);
      rl.on('line', line => {
        // Example of segments: [ 'Total', 'send', 'rate:', '26.6KB', '19.3KB', '42.4KB' ]
        const segments = line.split(/[ \t]+/)

        // 26.6        KB
        const parseUnits = segments[3].match(/([\d.]+)(\w+)/)
        let throughput = Number(parseUnits[1]) // 26.6
        if (parseUnits[2] in unitConvention) // KB, MB, GB
          throughput = throughput * unitConvention[parseUnits[2]]

        if (segments[1] == 'receive') {
          cache.rx = throughput
        }
        else if (segments[1] == 'send') {
          cache.tx = throughput
        }
      });
      rl.on('error', err => {
        log.error(`error parsing throughput output for ${target}`, err.toString());
      });

      cache.iftop = iftop
      cache.egrep = egrep
      cache.rl = rl
    }

    cache.ts = Date.now() / 1000
    return { target, rx: cache.rx || 0, tx: cache.tx || 0 }
  }

  getIntfThroughput(intf) {
    let intfCache = this.streamingCache[intf]
    if (!intfCache) {
      intfCache = this.streamingCache[intf] = {}
      intfCache.interval = setInterval(() => {
        this.getRate(intf)
          .then(res => Object.assign(intfCache, res))
      }, 1000)
    }
    intfCache.ts = Math.floor(new Date() / 1000)

    return { name: intf, rx: intfCache.rx || 0, tx: intfCache.tx || 0 }
  }

  async getIntfStats(intf) {
    const rx = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/rx_bytes`, 'utf8').catch(() => 0);
    const tx = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/tx_bytes`, 'utf8').catch(() => 0);
    return {rx, tx};
  }

  async getRate(intf) {
    try {
      const s1 = await this.getIntfStats(intf);
      await delay(1000);
      const s2 = await this.getIntfStats(intf);
      return {
        name: intf,
        rx: s2.rx > s1.rx ? s2.rx - s1.rx : 0,
        tx: s2.tx > s1.tx ? s2.tx - s1.tx : 0
      }
    } catch(err) {
      log.error('failed to fetch stats for', intf, err.message)
    }
  }

  async getFlows(type, target, ts, opts) {
    const now = Math.floor(new Date() / 1000);
    const ets = ts ? now - 2 : now
    ts = ts || now - 60
    const options = {
      ts,
      ets,
      count: 100,
      asc: true
    }
    if (Object.keys(opts).length) {
      Object.assign(options, opts)
    } else {
      options.auditDNSSuccess = true
      options.audit = true
    }

    if (type && target) {
      switch (type) {
        case 'host':
          options.mac = target
          break;
        case 'tag':
          options.tag = target
          break;
        case 'intf':
          options.intf = target
          break;
        case 'system':
          break;
        default:
          log.error("Unsupported type", type)
          return []
      }

    }
    const flows = await flowTool.prepareRecentFlows({}, options);
    return flows;
  }

  buildActiveConnGrepString() {
    const wanIPs = sysManager.myWanIps().v4;
    let str = "grep -v TIME_WAIT | fgrep -v '127.0.0.1' ";
    for(const ip of wanIPs) {
      str += `| egrep -v '=${ip}.*=${ip}'`;
    }
    return str;
  }

  async getActiveConnections() {
    // TBD, to be improved on the data accuracy and data parsing
    try {
      const ipv4Cmd = `sudo conntrack -o extended -L | ${this.buildActiveConnGrepString()} | wc -l`;
      log.debug(ipv4Cmd);
      const ipv4Count = await exec(ipv4Cmd);
      try {
        await exec("sudo modinfo nf_conntrack_ipv6"); // check if ipv6 kernel module is loaded, if not loaded, do not use the ipv6 data, which is not correct
        const ipv6Cmd = "sudo conntrack -L -f ipv6 2>/dev/null | fgrep -v =::1 | wc -l";
        const ipv6Count = await exec(ipv6Cmd);
        return Number(ipv4Count.stdout) + Number(ipv6Count.stdout);
      } catch(err) {
        log.debug("IPv6 conntrack kernel module not available");
        return Number(ipv4Count.stdout);
      }
    } catch(err) {
      log.error("Failed to get active connections, err:", err);
      return 0;
    }
  }
}

module.exports = LiveStatsPlugin;
