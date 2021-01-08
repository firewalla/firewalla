/*    Copyright 2016 Firewalla LLC
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


class LiveStatsPlugin extends Sensor {

  apiRun() {
    extensionManager.onGet("liveStats", async (msg, data) => {
      const intfs = fireRouter.getLogicIntfNames();
      const results = {};
      const promises = intfs.map( async (intf) => {
        const rate = await this.getRate(intf);
        results[intf] = rate;
      });
      promises.push(delay(1000)); // at least wait for 1 sec
      await Promise.all(promises);
      return results;
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
      rx: s2.rx > s1.rx ? s2.rx - s1.rx : 0,
      tx: s2.tx > s1.tx ? s2.tx - s1.tx : 0
    };
  }  
}

module.exports = LiveStatsPlugin;
