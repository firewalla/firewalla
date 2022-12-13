/*    Copyright 2021-2022 Firewalla Inc.
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
const HostManager = require('../net2/HostManager.js')
const hostManager = new HostManager()
const identityManager = require('../net2/IdentityManager');
const sem = require('./SensorEventManager.js').getInstance();

const fsp = require('fs').promises;
const exec = require('child-process-promise').exec;
const { spawn, ChildProcess } = require('child_process')
const { createInterface, Interface } = require('readline')
const _ = require('lodash')

const unitConvention = { KB: 1024, MB: 1024*1024, GB: 1024*1024*1024, TB: 1024*1024*1024*1024 };

const liveMetrics = require('../extension/metrics/liveMetrics');

class LiveStatsPlugin extends Sensor {
  registerStreaming(data) {
    const { streaming, target, type, queries } = data;
    const id = streaming.id
    if (! (id in this.streamingCache)) {
      this.streamingCache[id] = { target, type, queries }
    }
    this.streamingCache[id].ts = Date.now() / 1000
    return this.streamingCache[id]
  }

  resetThroughputCache(cache) {
    if (!cache) return
    if (cache.iftop) {
      cache.iftop.stdout && cache.iftop.stdout.unpipe()
      // iftop is invoked as root, cannot be terminated with kill()
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
      else {
        const logObject = this.streamingCache[message.id]
        for (const key in logObject) {
          if (logObject[key] instanceof ChildProcess)
            logObject[key] = _.pick(logObject[key], ['pid', 'spawnargs'])
          if (logObject[key] instanceof Interface)
            logObject[key] = 'Interface { ... }'
        }
        log.verbose(message.id, logObject)
      }
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

    extensionManager.onGet("liveMetrics",async(_msg,data)=>{
      return liveMetrics.collectMetrics();
    })

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
            const result = this.getDeviceThroughput(target)
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
            if (queries.throughput.devices) {
              sysManager.getMonitoringInterfaces().forEach(intf => {
                const result = response.throughput.find(i => intf.uuid == i.target)[0]
                if (result) Object.assign(result,
                  { devices: _.get(this.getIntfDeviceThroughput(intf.target), 'devices', {}) }
                )
              })
            }
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

      log.silly('Response:', response)
      return response
    });
  }

  getDeviceThroughput(target) {
    const host = hostManager.getHostFastByMAC(target) || identityManager.getIdentityByGUID(target);
    if (!host) {
      throw new Error(`Invalid host ${target}`)
    }

    const cache = _.get(this.getIntfDeviceThroughput(host.o.intf), ['devices', host.getGUID()], {tx: 0, rx: 0})

    // due to legacy reasons, traffic direction of individual device/identity is flipped on App,
    // reverse it here to get it correctly shown on App
    return {target, tx: cache.rx, rx: cache.tx}
  }

  getIntfDeviceThroughput(intfUUID) {
    let cache = this.streamingCache[intfUUID]
    if (!cache || !cache.iftop || !cache.egrep || !cache.rl) {
      const intf = sysManager.getInterfaceViaUUID(intfUUID)
      if (!intf) {
        log.error(`Invalid interface`, intfUUID)
      }

      log.verbose('(Re)Creating interface device throughput cache ...', intfUUID, intf.name)
      this.resetThroughputCache(cache)
      cache = this.streamingCache[intfUUID] = {}

      const iftopCmd = [
        'stdbuf', '-o0', '-e0',
        platform.getPlatformFilesPath() + '/iftop', '-c', platform.getPlatformFilesPath() + '/iftop.conf'
      ]

      iftopCmd.push('-i', intf.name, '-tB')
      const pcapFilter = []

      for (const v of [4,6]) {
        log.debug(`v${v} for`, intf)
        const IPs = intf[`ip${v}_addresses`]
        log.debug('IPs', IPs)
        if (IPs && IPs.length) {
          pcapFilter.push(... IPs.map(ip => `not host ${ip}`))
        }
        const subnet = v == 4 ? intf.subnetAddress4 : (intf.subnetAddress6 && intf.subnetAddress6[0])
        log.debug('subnet', subnet)
        if (subnet) {
          if (v == 6 && intf.subnetAddress6.length > 1) {
            log.warn(`${intf.name} has more than 1 v6 subnet`, intf.subnetAddress6.map(s => s.address))
          }
          log.debug(`subnet for ${intf.name} is ${subnet.address}`)

          // use -F/-G to get traffic direction, but only one subnet each family is allowed
          // https://code.blinkace.com/pdw/iftop/-/blob/master/iftop.c#L285-351
          iftopCmd.push(v == 4 ? '-F' : '-G', subnet.address)

          // pcap filter `net` requires using the starting address
          const pcapNet = subnet.startAddress().address + subnet.subnet
          pcapFilter.push(`not (src net ${pcapNet} and dst net ${pcapNet})`)
        }
      }

      iftopCmd.push('-f', pcapFilter.join(' and '))

      // sudo has to be the first command otherwise stdbuf won't work for privileged command
      const iftop = spawn('sudo', iftopCmd);
      log.debug(iftop.spawnargs)
      iftop.on('error', err => {
        log.error(`iftop error for ${intf.name}`, err.toString());
      });
      const egrep = spawn('stdbuf', ['-o0', '-e0', 'egrep', '<?=>?'])
      egrep.on('error', err => {
        log.error(`egrep error for ${intf.name}`, err.toString());
      });

      iftop.stdout.pipe(egrep.stdin)

      const rl = createInterface(egrep.stdout);
      rl.on('line', line => {
        // Example of segments: [ 'Total', 'send', 'rate:', '26.6KB', '19.3KB', '42.4KB' ]
        const segments = line.trim().split(/[ \t]+/)
        if (segments.length < 4) return

        let ip, numSlot, tx
        if (segments[0] != '*') {
          tx = true
          cache.lastLineIP = ip = segments[1]
          numSlot = 3
        } else {
          tx = false
          ip = cache.lastLineIP
          numSlot = 2
        }

        const parseUnits = segments[numSlot].match(/([\d.]+)(\w+)/)
        let throughput = Number(parseUnits[1]) // 26.6
        if (parseUnits[2] in unitConvention) // KB, MB, GB
          throughput = throughput * unitConvention[parseUnits[2]]

        const host = hostManager.getHostFast(ip) || hostManager.getHostFast6(ip) || identityManager.getIdentityByIP(ip);
        if (!host) return

        // log.debug('Setting cache', host.getGUID(), tx ? 'tx' : 'rx', throughput)
        _.set(cache, ['devices', host.getGUID(), tx ? 'tx' : 'rx'], throughput)
      });
      rl.on('error', err => {
        log.error(`error parsing throughput output for ${intf.name}`, err.toString());
      });

      cache.iftop = iftop
      cache.egrep = egrep
      cache.rl = rl
    }

    cache.ts = Date.now() / 1000
    return { intf: intfUUID, devices: cache.devices }
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
    const rx = await fsp.readFile(`/sys/class/net/${intf}/statistics/rx_bytes`, 'utf8').catch(() => 0);
    const tx = await fsp.readFile(`/sys/class/net/${intf}/statistics/tx_bytes`, 'utf8').catch(() => 0);
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
