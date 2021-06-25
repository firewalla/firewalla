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
const HostManager = require('../net2/HostManager.js')
const hostManager = new HostManager()
const sem = require('./SensorEventManager.js').getInstance();

const Promise = require('bluebird');
const fs = require('fs');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const { spawn } = require('child_process')

const unitConvention = { K: 1024, M: 1024*1024, G: 1024*1024*1024 }

class LiveStatsPlugin extends Sensor {
  registerStreaming(data) {
    const { streaming, target, type, queries } = data;
    const id = streaming.id
    if (! (id in this.streamingCache)) {
      this.streamingCache[id] = { target, type, queries }
    }

    return this.streamingCache[id]
  }

  cleanupStreaming() {
    for (const id in this.streamingCache) {
      const cache = this.streamingCache[id];
      if(cache.ts < Math.floor(new Date() / 1000) - 1800) {
        if (cache.rl) cache.rl.close()
        if (cache.egrep) cache.egrep.kill()
        if (cache.iftop) cache.iftop.kill()
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
        log.debug(Object.keys(this.streamingCache))
      else
        log.debug(this.streamingCache[message.id])
    })

    setInterval(() => {
      this.cleanupStreaming()
    }, 60 * 1000); // cleanup every 1 mins

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
          const prevFlows = await this.getFlows(type, target)
          while (prevFlows.length) flows.push(prevFlows.shift())
          lastTS = this.lastFlowTS(flows) && now;
        } else {
          if (lastTS < now - 60) {
            lastTS = now - 60; // self protection, ignore very old ts
          }
        }

        const newFlows = await this.getFlows(type, target, lastTS);
        while (newFlows.length) flows.push(newFlows.shift())

        const newFlowTS = this.lastFlowTS(flows) || lastTS;
        cache.flowTs = newFlowTS;
        response.flows = flows
      }

      if (queries && queries.throughput) {
        switch (type) {
          case 'host':
            if (!platform.getIftopPath()) break;

            response.throughput = [ this.getDeviceThroughput(target, cache) ]
            break;
          case 'intf':
          case 'system': {
            if (type == 'intf') {
              response.throughput = [ { name: sysManager.getInterfaceViaUUID(target).name, target } ]
            } else {
              response.throughput = fireRouter.getLogicIntfNames()
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
      if (cache.rl) cache.rl.close()
      if (cache.egrep) cache.egrep.kill()
      if (cache.iftop) cache.iftop.kill()

      const host = hostManager.getHostFastByMAC(target)
      // sudo has to be the first command otherwise stdbuf won't work for privileged command
      const iftop = spawn('sudo', [
        'stdbuf', '-o0', '-e0',
        platform.getIftopPath(), '-c', platform.getPlatformFilesPath() + '/iftop.conf',
        '-i', sysManager.getInterfaceViaUUID(host.o.intf).name, '-tB', '-f', 'ether host ' + host.o.mac
      ]);
      log.debug(iftop.spawnargs)
      iftop.on('error', err => console.error(err))
      const egrep = spawn('sudo', ['stdbuf', '-o0', '-e0', 'egrep', 'Total (send|receive) rate:'])
      iftop.stdout.pipe(egrep.stdin)

      const rl = require('readline').createInterface(egrep.stdout);
      rl.on('line', line => {
        const segments = line.split(/[ \t]+/)
        const parseUnits = segments[3].match(/[\d.]+|\w/)
        let throughput = Number(parseUnits[0])
        if (parseUnits[1] in unitConvention)
          throughput = throughput * unitConvention[parseUnits[1]]

        if (segments[1] == 'receive') {
          cache.rx = throughput
        }
        else if (segments[1] == 'send') {
          cache.tx = throughput
        }
      });

      iftop.stderr.on('data', (data) => {
        log.error(`throughtput ${target} stderr: ${data.toString}`);
      });

      iftop.on('error', err => {
        log.error(`iftop error for ${target}`, err.toString());
      });

      egrep.on('error', err => {
        log.error(`egrep error for ${target}`, err.toString());
      });

      rl.on('error', err => {
        log.error(`error parsing throughput output for ${target}`, err.toString());
      });

      cache.iftop = iftop
      cache.egrep = egrep
      cache.rl = rl
    }

    return { target, rx: cache.rx, tx: cache.tx }
  }

  getIntfThroughput(intf) {
    let intfCache = this.streamingCache[intf]
    if (!intfCache) {
      intfCache = this.streamingCache[intf] = {}
      intfCache.interval = setInterval(() => {
        this.getRate(intf)
          .then(res => {
            intfCache.tx = res.tx
            intfCache.rx = res.rx
          })
          .catch( err => log.error('failed to fetch stats for', intf, err.message))
      }, 1000)
    }
    intfCache.ts = Math.floor(new Date() / 1000)

    return { name: intf, rx: intfCache.rx, tx: intfCache.tx }
  }

  async getIntfStats(intf) {
    const rx = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/rx_bytes`, 'utf8').catch(() => 0);
    const tx = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/tx_bytes`, 'utf8').catch(() => 0);
    return {rx, tx};
  }

  async getRate(intf) {
    const s1 = await this.getIntfStats(intf);
    await delay(1000);
    const s2 = await this.getIntfStats(intf);
    return {
      name: intf,
      rx: s2.rx > s1.rx ? s2.rx - s1.rx : 0,
      tx: s2.tx > s1.tx ? s2.tx - s1.tx : 0
    };
  }

  async getFlows(type, target, ts) {
    const now = Math.floor(new Date() / 1000);
    const ets = ts ? now - 2 : now
    ts = ts || now - 60
    const options = {
      ts,
      ets,
      count: 100,
      asc: true,
      auditDNSSuccess: true,
      audit: true,
    }
    if (type && target) {
      switch (type) {
        case 'host':
          options.mac = target.toUpperCase()
          break;
        case 'intf':
          options.intf = target
          break;
        default:
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
