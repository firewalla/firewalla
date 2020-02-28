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

const rclient = require('../util/redis_manager.js').getRedisClient();

const Promise = require('bluebird');

const license = require('../util/license.js')

const key = "firekick:pairing:message";
const totalTimeout = 60 * 1000;


function delay(t) {
  return new Promise(function (resolve) {
    setTimeout(resolve, t);
  });
}

class AdditionalPairPlugin extends Sensor {

  apiRun() {
    extensionManager.onGet("pairingPayload", async () => {
      return this.getPayload();
    })
  }

  async getPayload() {
    return Promise.any([
      delay(totalTimeout), 
      this.waitingForPayload(20)
    ]);
  }

  async waitingForPayload(ttl) {
    for (let i = 0; i < ttl; i++) {
      const result = await rclient.getAsync(key);
      if(result) {
        try {
          const payload = JSON.parse(result);
          const licenseData = await license.getLicenseAsync();
          if(licenseData && licenseData.DATA && licenseData.DATA.UUID) {
            payload.license = licenseData.DATA.UUID;
          }
          return payload;
        } catch(err) {
          return null;
        }        
      } else {
        await delay(3000);
      }
    }
    return null;
  }

}

module.exports = AdditionalPairPlugin;
