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

let log = require('../net2/logger.js')(__filename, 'info');

let Hook = require('./Hook.js');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let redis = require('redis');
let rclient = redis.createClient();

let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);
Promise.promisifyAll(redis.Multi.prototype);

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let DNSManager = require('../net2/DNSManager.js');
let dnsManager = new DNSManager('info');

class DestIPFoundHook extends Hook {

  run() {
    sem.on('DestIPFound', (event) => {

      let ip = event.ip;




      // ignore unknown updates
      if(name.toLowerCase() === "unknown")
        return;

      hostTool.macExists(mac)
        .then((result) => {
          if (!result)
            return;

          hostTool.updateBackupName(mac, name)
            .then(() => {})
            .catch((err) => {
              log.error("Failed to update backup name: ", err, {})
            })
        })
    });
  }
}

module.exports = DestIPFoundHook;
