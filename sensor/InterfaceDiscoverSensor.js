/*    Copyright 2016-2021 Firewalla Inc.
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

const Discovery = require('../net2/Discovery.js');
const d = new Discovery(process.title);

class InterfaceDiscoverSensor extends Sensor {
  run() {
    process.nextTick(() => {
      this.checkAndRunOnce();
    });
    setInterval(() => {
      this.checkAndRunOnce();
    }, 1000 * 60 * 20); // 20 minutes.  (See if dhcp changed anything ...)
  }

  async checkAndRunOnce() {
    try {
      await d.discoverInterfacesAsync(false);
    } catch(err) {
      log.error('Failed to check interfaces', err)
    }
  }

}

module.exports = InterfaceDiscoverSensor;
