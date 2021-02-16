/*    Copyright 2021 Firewalla INC
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

const fs = require('fs');
Promise.promisifyAll(fs);

const exec = require('child-process-promise').exec;

const sysManager = require('../net2/SysManager.js');


class LiveStatsPlugin extends Sensor {

  async apiRun() {
    this.activeConnCount = await this.getActiveConnections();

    this.timer = setInterval(async () => {
      this.activeConnCount = await this.getActiveConnections();      
    }, 300 * 1000); // every 5 mins;

    extensionManager.onGet("liveStats", async (msg, data) => {
      const intfs = fireRouter.getLogicIntfNames();
      const intfStats = [];
      const promises = intfs.map( async (intf) => {
        const rate = await this.getRate(intf);
        intfStats.push(rate);
      });
      promises.push(delay(1000)); // at least wait for 1 sec
      await Promise.all(promises);
      return {intfStats, activeConn: this.activeConnCount};
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

  buildActiveConnGrepString() {
    const wanIPs = sysManager.myWanIps();
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
        log.error("IPv6 conntrack kernel module not available");
        return Number(ipv4Count.stdout);
      }
    } catch(err) {
      log.error("Failed to get active connections, err:", err);
      return 0;
    }
  }
}

module.exports = LiveStatsPlugin;
