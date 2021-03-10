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

const Promise = require('bluebird');

const fireRouter = require('../net2/FireRouter.js')

const delay = require('../util/util.js').delay;

const flowTool = require('../net2/FlowTool');

const fs = require('fs');
Promise.promisifyAll(fs);

const exec = require('child-process-promise').exec;

const sysManager = require('../net2/SysManager.js');


class LiveStatsPlugin extends Sensor {

  registerStreaming(streaming) {
    const id = streaming.id;
    if (! (id in this.streamingCache)) {
      this.streamingCache[id] = {}
    }
  }

  lastStreamingTS(id) {
    return this.streamingCache[id] && this.streamingCache[id].ts;
  }

  updateStreamingTS(id, ts) {
    this.streamingCache[id].ts = ts;
  }

  cleanupStreaming() {
    for(const id in this.streamingCache) {
      const cache = this.streamingCache[id];
      if(cache.ts < Math.floor(new Date() / 1000) - 1800) {
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

    setInterval(() => {
      this.cleanupStreaming()
    }, 600 * 1000); // cleanup every 10 mins

    this.timer = setInterval(async () => {
      this.activeConnCount = await this.getActiveConnections();      
    }, 300 * 1000); // every 5 mins;

    extensionManager.onGet("liveStats", async (msg, data) => {
      const streaming = data.streaming;
      const id = streaming.id;
      this.registerStreaming(streaming);

      let lastTS = this.lastStreamingTS(id);
      const now = Math.floor(new Date() / 1000);
      let flows = [];

      if(!lastTS) {
        const prevFlows = (await this.getPreviousFlows()).reverse();
        flows.push.apply(flows, prevFlows);
        lastTS = this.lastFlowTS(prevFlows) && now;
      } else {
        if (lastTS < now - 60) {
          lastTS = now - 60; // self protection, ignore very old ts
        }
      }

      const newFlows = await this.getFlows(lastTS);
      flows.push.apply(flows, newFlows);

      let newFlowTS = this.lastFlowTS(newFlows) || lastTS;
      this.updateStreamingTS(id, newFlowTS);

      const intfs = fireRouter.getLogicIntfNames();
      const intfStats = [];
      const promises = intfs.map( async (intf) => {
        const rate = await this.getRate(intf);
        intfStats.push(rate);
      });
      promises.push(delay(1000)); // at least wait for 1 sec
      await Promise.all(promises);
      return {flows, intfStats, activeConn: this.activeConnCount};
    });
  }

  async getIntfStats(intf) {
    const rx = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/rx_bytes`, 'utf8');
    const tx = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/tx_bytes`, 'utf8');
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

  async getPreviousFlows() {
    const now = Math.floor(new Date() / 1000);
    const flows = await flowTool.prepareRecentFlows({}, {
      ts: now,
      ets: now-60, // one minute
      count: 100,
      auditDNSSuccess: true,
      audit: true
    });
    return flows;
  }

  async getFlows(ts) {
    const now = Math.floor(new Date() / 1000);
    const flows = await flowTool.prepareRecentFlows({}, {
      ts,
      ets: now-2,
      count: 100,
      asc: true,
      auditDNSSuccess: true,
      audit: true
    });
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
