/*    Copyright 2022 Firewalla INC
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

const rclient = require('../../util/redis_manager.js').getRedisClient()
const log = require('../../net2/logger.js')(__filename);

const NetworkProfileManager = require('../../net2/NetworkProfileManager');
const SysInfo = require('../sysinfo/SysInfo.js');
const HostManager = require('../../net2/HostManager.js');
const hostManager = new HostManager();
const Constants = require('../../net2/Constants.js');
const uuid = require('uuid');

const _ = require('lodash');

let instance = null;

class LiveMetrics {
  constructor() {
    if (instance === null) {
      instance = this;
      this.streamingId = uuid.v4();
    }
    return instance;
  }

  async collectMetrics() {
    const begin = Date.now() / 1000;

    const metrics = {};
    const extensionManager = require('../../sensor/ExtensionManager');

    // wan throughput
    const intfStats = (await extensionManager.get("liveStats", null, {
      type: "system",
      queries: { throughput: true },
      streaming: { id: this.streamingId }
    })).throughput;
    const activeWans = NetworkProfileManager.getActiveWans().map(intf => intf.uuid);
    const wanStats = intfStats.filter(x => activeWans.includes(x.target))
    let rx = 0, tx = 0;
    wanStats.forEach(w => { rx += w.rx; tx += w.tx });
    metrics.throughput = {
      rx, tx
    }

    // data usage
    metrics.dataUsage = await extensionManager.get("monthlyUsageStats");

    const sysInfo = SysInfo.getSysInfo();

    // disk usage
    const homeMount = _.find(sysInfo.diskInfo, { mount: "/home" })
    metrics.diskUsage = homeMount ? parseFloat((homeMount.used / homeMount.size).toFixed(4)) : null;

    // os uptime
    metrics.osUptime = sysInfo.osUptime;

    // cpu usage
    const cpuUsageRecords = await rclient.zrangebyscoreAsync(Constants.REDIS_KEY_CPU_USAGE, Date.now() / 1000 - 60, Date.now() / 1000).map(r => JSON.parse(r));
    if (cpuUsageRecords.length > 0) {
      const sum = _.sumBy(cpuUsageRecords, (o) => 100 - o.idle);
      // 2+4+2+2 = 10， 10/4 = 2.5
      // 2.5 means 2.5%
      metrics.cpuUsage = parseFloat((sum / cpuUsageRecords.length / 100).toFixed(4));
    }


    // memory usage
    metrics.memUsage = parseFloat(sysInfo.realMem.toFixed(4));

    // flows 
    const flowStats = await hostManager.getStats({ granularities: '1hour', hits: 24 }, "0.0.0.0", ['conn', 'ipB', 'dns', 'dnsB']);
    metrics.flows = {
      total: flowStats.totalConn + flowStats.totalDns + flowStats.totalDnsB + flowStats.totalIpB,
      blocked: flowStats.totalDnsB + flowStats.totalIpB
    }
    log.info("Collect live mode metrics cost ", (Date.now() / 1000 - begin).toFixed(2));
    return metrics;
  }
}

module.exports = new LiveMetrics();