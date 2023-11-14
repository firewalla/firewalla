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
const Mode = require('../net2/Mode.js');
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

const fsp = require('fs').promises;
const exec = require('child-process-promise').exec;
const { spawn, ChildProcess } = require('child_process')
const { createInterface, Interface } = require('readline')
const _ = require('lodash')
const { Address6 } = require('ip-address')

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
    if (cache.rl) {
      cache.rl.close()
      delete cache.rl
    }
    if (cache.timeout)
      clearTimeout(cache.timeout)
  }

  resetLatencyCache(cache) {
    if (!cache) return
    if (cache.ping) {
      cache.ping.proc && cache.ping.proc.stdout && cache.ping.proc.stdout.unpipe()
      exec(`kill ${cache.ping.proc.pid}`).catch((err) => {})
      if (cache.ping.rl) {
        cache.ping.rl.close();
      }
      delete cache.ping
    }
  }

  cleanupStreaming() {
    for (const id in this.streamingCache) {
      const cache = this.streamingCache[id];

      if (cache.ts < Math.floor(new Date() / 1000) - (this.config.cacheTimeout || 30)) {
        log.verbose('Cleaning cache for', cache.target || id)
        this.resetThroughputCache(cache)
        this.resetLatencyCache(cache)
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
            logObject[key] = 'readline.Interface { ... }'
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

      if (queries && queries.latency) {
        // only support device ping latency
        if (type === "host") {
          const latency = await this.getDeviceLatency(target);
          response.latency = latency ? [ latency ] : [];
        }
      }

      if (queries && queries.staInfo) {
        // only support device sta information
        if (type === "host") {
          const staStatus = await fireRouter.getAllSTAStatus();
          if (staStatus && staStatus[target])
            response.staInfo = [Object.assign({ target }, staStatus[target])];
          else
            response.staInfo = [];
        }
      }

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
            const result = await this.getDeviceThroughput(target)
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
              for (const intf of sysManager.getMonitoringInterfaces()) {
                // exclude primary network in DHCP mode, this is mainly for old models that have different subnets
                // for primary and overlay
                // bridge mode is only supported with FireRouter so don't worry about it
                if (!platform.isFireRouterManaged() && await Mode.isDHCPModeOn() && intf.type == 'wan') continue

                const devices = _.get(await this.getIntfDeviceThroughput(intf.uuid), 'devices', {})
                const result = response.throughput.find(i => intf.uuid == i.target)
                if (result)
                  Object.assign(result, { devices })
                else
                  response.throughput.push({ name: intf.name, target: intf.uuid, devices })
              }
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

    sclient.subscribe("Mode:Change");
    sclient.on("message", async (channel, message) => {
      // monitoring mode switching to spoof, reset cache and start iftop with extra filter
      if (channel === "Mode:Change") {
        log.info(`Setting mode to ${message}, restarting iftop ...`)
        for (const id in this.streamingCache) {
          const cache = this.streamingCache[id]
          if (cache.iftop) {
            log.info('Resetting cache for', id)
            this.resetThroughputCache(cache)
          }
        }
      }
    })

    await hostManager.getHostsAsync();
  }

  async getDeviceLatency(target) {
    const host = hostManager.getHostFastByMAC(target) || identityManager.getIdentityByGUID(target);
    if (!host) {
      throw new Error(`Invalid host ${target}`);
    }
    const ip = host.constructor.name === "Host" ? host.o.ipv4Addr : host.getIPs()[0];
    if (!ip) {
      log.error(`Host ${target} does not have an IP address`);
      return {target, latency: -1};
    }
    let cache = this.streamingCache[target] || {};
    if (!cache.ping) {
      try {
        this.resetLatencyCache(cache);
        cache.ping = {};
        this.streamingCache[target] = cache;
        const pingArgs = ['-W', '1', '-O', ip];
        const ping = spawn('ping', pingArgs);
        ping.on('error', (err) => {
          log.error(`ping error for ${target}`, err.message);
        });
        const rl = createInterface(ping.stdout);
        rl.on('line', (line) => {
          if (line.startsWith("no answer yet")) {
            cache.ping.latency = -1;
          } else {
            const timeStr = line.split(' ').find(seg => seg.startsWith("time="));
            if (timeStr) {
              const latency = timeStr.split('=')[1];
              if (isNaN(latency))
                cache.ping.latency = -1;
              else
                cache.ping.latency = Number(latency);
            }
          }
        });
        rl.on('error', (err) => {
          log.error(`error parsing ping output for ${target}`, err.message)
        });
        cache.ping = {proc: ping, rl}
      } catch (err) {
        log.error(`Failed to get device latency of ${target}`, err.message);
      }
    }
    cache.ts = Date.now() / 1000
    return { target: target, latency: cache.ping.latency};
  }

  async getDeviceThroughput(target) {
    const host = hostManager.getHostFastByMAC(target) || identityManager.getIdentityByGUID(target);
    if (!host) {
      throw new Error(`Invalid host ${target}`)
    }

    const cache = _.get(await this.getIntfDeviceThroughput(host.getNicUUID()), ['devices', host.getGUID()], {tx: 0, rx: 0})

    // due to legacy reasons, traffic direction of individual device/identity is flipped on App,
    // reverse it here to get it correctly shown on App
    return {target, tx: cache.rx, rx: cache.tx}
  }

  async getIntfDeviceThroughput(intfUUID) {
    let cache = this.streamingCache[intfUUID] || {}
    if (!cache.iftop || !cache.rl) try {
      const intf = sysManager.getInterfaceViaUUID(intfUUID)
      if (!intf) {
        throw new Error(`Invalid interface`, intfUUID)
      }

      log.verbose('(Re)Creating interface device throughput cache ...', intfUUID, intf.name)
      this.resetThroughputCache(cache)
      cache = this.streamingCache[intfUUID] = {}

      const iftopCmd = [
        'stdbuf', '-o0', '-e0',
        platform.getPlatformFilesPath() + '/iftop', '-c', platform.getPlatformFilesPath() + '/iftop.conf'
      ]

      iftopCmd.push('-i', intf.name, '-t')
      const pcapFilter = []
      const pcapSubnets = []

      for (const v of [4,6]) {
        const IPs = intf[`ip${v}_addresses`]
        log.debug(`v${v} for`, intf.name, 'IPs', IPs)
        if (IPs && IPs.length) {
          pcapFilter.push(... IPs.map(ip => `not host ${ip}`))
        }

        let subnet = v == 4 ? intf.subnetAddress4 : (intf.subnetAddress6 && intf.subnetAddress6[0])
        if (subnet) {
          // TODO: only 1 subnet is supported now, assume v6 addresses are in the same subnet
          if (v == 6 && intf.subnetAddress6.length > 1) {
            log.verbose(`${intf.name} has more than 1 v6 subnet`, intf.subnetAddress6.map(s => s.address))
            if (subnet.subnetMask == 128) { // static IP, trying to find one with dynamic range
              subnet = intf.subnetAddress6.find(n => n.subnetMask < 128) || subnet
            }
          }
          // v6, if only /128 address is found, set it to /64
          if (subnet.subnetMask == 128) {
            log.warn(`${intf.name} have only static v6 IP, using /64 for traffic capture`)
            subnet = new Address6(subnet.addressMinusSuffix + '/64')
          }
          log.debug(`subnet for ${intf.name} is ${subnet.address}`)

          // use -F/-G to get traffic direction, but only one subnet each family is allowed
          // https://code.blinkace.com/pdw/iftop/-/blob/master/iftop.c#L285-351
          iftopCmd.push(v == 4 ? '-F' : '-G', subnet.address)

          // pcap filter `net` requires using the starting address
          const pcapNet = subnet.startAddress().address + subnet.subnet
          pcapSubnets.push(pcapNet)
          pcapFilter.push(`not src and dst net ${pcapNet}`)
        }
      }

      if (await Mode.isSpoofModeOn()) {
        // filter traffic between Firewalla and router: IP in monitoring subnet but with Firewalla's MAC
        pcapFilter.push(... ['src', 'dst'].map(dir =>
          `not (ether ${dir} ${intf.mac_address} and (${dir} net ${pcapSubnets.join(' or ')}))`
        ))
      }

      // exclude multicast traffic
      pcapFilter.push("(not net 224.0.0.0/4)");
      // only include L4 protocols and exclude TCP packets with SYN/FIN/RST flags
      pcapFilter.push("(udp or icmp or (tcp[13] & 0x7 == 0) or (ip6[6] == 6 && ip6[53] & 0x7 == 0))")

      iftopCmd.push('-f', pcapFilter.join(' and '))

      // sudo has to be the first command otherwise stdbuf won't work for privileged command
      const iftop = spawn('sudo', iftopCmd);
      log.debug(iftop.spawnargs)
      iftop.on('error', err => {
        log.error(`iftop error for ${intf.name}`, err.toString());
      });
      iftop.stderr.on('data', data => {
        const str = data.toString()
        if (str.toLowerCase().includes('err')) log.error(str)
      })

      const rl = createInterface(iftop.stdout);
      rl.on('line', line => {
        // only parse line with direction indicator or end of session mark
        if (!line.includes('=')) return

        //   1 192.168.89.144                           =>       326B       757B     2.13KB      223KB
        //      *                                       <=       336B     1.08KB     2.48KB      225KB
        //============================================================================================
        const segments = line.trim().split(/[ \t]+/)
        if (segments.length < 4) {
          // end of a single session, reset aggregate flag of all devices
          for (const device in cache.devices) {
            if (cache.devices[device].add)
              cache.devices[device].add = false
            else
              delete cache.devices[device]
          }
          log.debug(cache.devices)

          if (cache.timeout) clearTimeout(cache.timeout)
          // if no traffic is captured, iftop doesn't print anything, thus leave no chance for code to be run
          // with readline, set a timer here to clear what's left in the cache
          cache.timeout = setTimeout(() => {
            delete cache.devices
          }, 10 * 1000)
          return
        }
        // log.debug(line)

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
        if (!parseUnits || parseUnits.length < 3) {
          log.error('Error parsing:', line)
          return
        }
        let throughput = Number(parseUnits[1]) // 26.6
        if (parseUnits[2] in unitConvention) // KB, MB, GB
          throughput = throughput * unitConvention[parseUnits[2]]

        const host = hostManager.getHostFast(ip) || hostManager.getHostFast6(ip) || identityManager.getIdentityByIP(ip);
        if (!host) return

        const guid = host.getGUID()
        const add = _.get(cache, ['devices', guid, 'add'], false)
        // log.debug('device', guid, add, cache.devices && cache.devices[guid])
        if (!add) {
          _.set(cache, ['devices', guid, tx ? 'tx' : 'rx'], throughput)
          // set the aggregate flag only when both direction is done
          if (!tx) cache.devices[guid].add = true
        } else {
          // this has been set before, no need to use _.set()
          cache.devices[guid][tx ? 'tx' : 'rx'] += throughput
        }
      });
      rl.on('error', err => {
        log.error(`error parsing throughput output for ${intf.name}`, err.toString());
      });

      cache.iftop = iftop
      cache.rl = rl
    } catch(err) {
      log.error('Failed to get device throughput', err)
    }

    cache.ts = Date.now() / 1000
    return { intf: intfUUID, devices: _.mapValues(cache.devices, d => { return { tx: d.tx, rx: d.rx } } ) }
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
