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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const bonjour = require('../vendor_lib/bonjour')()

const EncipherTool = require('../net2/EncipherTool.js')
const encipherTool = new EncipherTool()

const port = 8833

/*
 * This Sensor publish Firewalla API to local network via bonjour protocol
 * It can speed up the process for App to find local connected pi (even when ip address is changed)
 */
class APISensor extends Sensor {
  async run() {
    let gid = await encipherTool.getGID()

    if (gid) {
      const name = `FireAPI-${gid}`
      bonjour.publish({
        name: name,
        type: 'http',
        port: 8833
      }).on('error', (err) => log.error("Error publish FireAPI via bonjour", err));

      process.on('exit', () => {
        log.info("Unpublish FireAPI bonjour broadcast before process exits")
        bonjour.unpublishAll()
      })
    }
  }
}

module.exports = APISensor
