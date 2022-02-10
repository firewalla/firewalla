/*    Copyright 2022 Firewalla Inc.
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

const sem = require('./SensorEventManager.js').getInstance();

const extensionManager = require('./ExtensionManager.js')
const Sensor = require('./Sensor.js').Sensor;

class IntelSensor extends Sensor {
  constructor(config) {
    super(config);
  }

  async apiRun() {
    extensionManager.onCmd("intel:url:check", async (msg, data) => {
      await this._check(data);
    });
  }

  async _check(options = {}) {
    const url = options.url;

    if(!url) {
      log.info("require url");
      return;
    }

    sem.sendEventToFireMain({
      type: 'DestURL',
      url
    });
  }
}

module.exports = IntelSensor;
