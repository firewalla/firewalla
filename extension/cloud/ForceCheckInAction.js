/*    Copyright 2019 Firewalla INC
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

const CloudAction = require('./CloudAction.js');
const log = require('../../net2/logger.js')(__filename);
const Promsie = require('bluebird');
const sem = require('../../sensor/SensorEventManager.js').getInstance();

module.exports = class extends CloudAction {
  async run() {
    return new Promise(resolve => {
      sem.sendEventToFireMain({
        type: 'CloudReCheckin',
        message: "",
      });

      sem.once("CloudReCheckinComplete", async (event) => {
        resolve();
      })
    });
  }
}
