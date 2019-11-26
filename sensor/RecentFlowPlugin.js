/*    Copyright 2016 - 2019 Firewalla INC
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

const sem = require('../sensor/SensorEventManager.js').getInstance()

const extensionManager = require('./ExtensionManager.js')

const FlowTool = require('../net2/FlowTool');
const flowTool = new FlowTool();

class RecentFlowPlugin extends Sensor {

  run() {
    sem.on("NewGlobalFlow", async (event) => {
      const flow = event.flow;
      if(!flow) {
        return;
      }

      await flowTool.saveGlobalRecentConns(flow);
    });
  }

  apiRun() {
    extensionManager.onGet("flow:global:recent", async (msg, options) => {
      const flows = await flowTool.getGlobalRecentConns(options);
      return {flows};
    })
  }

}

module.exports = RecentFlowPlugin;
