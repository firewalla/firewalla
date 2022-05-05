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

const log = require('../net2/logger.js')(__filename);
const extensionManager = require('../sensor/ExtensionManager.js');
const Sensor = require('./Sensor.js').Sensor;
const key = "action:history";
const rclient = require('../util/redis_manager').getRedisClient();
const sem = require('./SensorEventManager.js').getInstance();

class ActionPlugin extends Sensor {
  constructor() {
    super()
  }
  async apiRun() {
    extensionManager.onGet("actionHistory", async (msg, data) => {
      return this.getActionHistory(data);
    });
    sem.on('RecordAction', async (event) => {
      try {
        const action = event.action;
        const ts = Date.now() / 1000;
        await this.recordAction(Object.assign({ ts }, action));
      } catch (e) {
        log.warn('Record action error', e);
      }
    })
  }

  async getActionHistory(options = {}) {
    try {
      log.info("get action history options", options);
      let { ts, count, ets } = options;
      if (!ets) ets = Date.now() / 1000;
      if (!count) count = 200;
      ts = ts ? `(${ts}` : '-inf';
      const results = await rclient.zrangebyscoreAsync(key, ts, ets, "LIMIT", 0, count);
      if (results === null || results.length === 0) {
        return [];
      }
      const actionObjects = results
        .map(str => {
          const obj = this.stringToJSON(str)
          if (!obj) return null;
          return obj;
        })
        .filter(x => !!x);

      const result = {
        count: actionObjects.length,
        actions: actionObjects,
        nextTs: actionObjects.length ? actionObjects[actionObjects.length - 1].ts : null
      }
      return result;
    } catch (e) {
      log.warn('Get action history error', e);
      return null;
    }
  }

  async recordAction(action) {
    const ts = action.ts;
    await rclient.zaddAsync(key, ts, JSON.stringify(action))
  }

  stringToJSON(string) {
    try {
      return JSON.parse(string);
    } catch (err) {
      log.debug('Failed to parse log', string)
      return null;
    }
  }
}


module.exports = ActionPlugin;