/*    Copyright 2020 Firewalla INC 
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
const Sensor = require('./Sensor.js').Sensor;
const sem = require('../sensor/SensorEventManager.js').getInstance();
const rclient = require('../util/redis_manager.js').getRedisClient();
const Mode = require('../net2/Mode.js');
const sysManager = require('../net2/SysManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const modeManager = require('../net2/ModeManager.js');

const routerChangeKey = 'sys:router:change';
const routerMacKey = 'sys:router:mac';

class RouterChangeSensor extends Sensor {
  constructor() {
    super();
  }

  async run() {
    sem.once('IPTABLES_READY', async() => {
      await this.checkRouteMac();
    });
    sem.on('NewDeviceFound', async (event) => {
      await this.checkRouteMac();
    });
  }

  async checkRouteMac() {
    if (!Mode.isSpoofModeOn()) {
      return;
    }

    const gatewayIp = sysManager.myGateway();
    const gatewayMac = await hostTool.getMacByIP(gatewayIp);
    const isMember = await rclient.sismemberAsync(routerMacKey, gatewayMac);
    const hasAny = await rclient.scardAsync(routerMacKey);
    if (!isMember && hasAny > 0) {
      await modeManager.setNoneAndPublish();
      await rclient.setAsync(routerChangeKey, 1);
      await rclient.expireAsync(routerChangeKey, 3600 * 24 * 7); // one week
    }
    if (!isMember) {
      await rclient.saddAsync(routerMacKey, gatewayMac);
    }
  }
}

module.exports = RouterChangeSensor;
