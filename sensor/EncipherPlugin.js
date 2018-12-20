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

const sem = require('../sensor/SensorEventManager.js').getInstance()

const extensionManager = require('./ExtensionManager.js')

const EncipherTool = require('../net2/EncipherTool.js')
const encipherTool = new EncipherTool()

const rclient = require('../util/redis_manager.js').getRedisClient();

class EncipherPlugin extends Sensor {

  apiRun() {
    extensionManager.onCmd("group:eid:delete", async (msg, data) => {
      const eid = data.eid;
      return this.deleteEidFromGroup(eid);
    })
  }

  async deleteEidFromGroup(eid) {
    if(!this.eptcloud) {
      return;
    }

    const gid = await encipherTool.getGID();
    await this.eptcloud.deleteEidFromGroup(gid, eid);
    await rclient.hdelAsync("sys:ept:memberNames", eid);
    await rclient.hdelAsync("sys:ept:member:lastvisit", eid);
    return;
  }
}

module.exports = EncipherPlugin;
