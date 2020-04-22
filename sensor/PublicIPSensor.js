/*    Copyright 2016 - 2020 Firewalla Inc
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

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');

const exec = require('child-process-promise').exec;

const rp = require('request-promise');

const command = "dig +short myip.opendns.com @resolver1.opendns.com";
const redisKey = "sys:network:info";
const redisHashKey = "publicIp";

class PublicIPSensor extends Sensor {
  constructor() {
    super();
  }

  async job() {
    try {
      // dig +short myip.opendns.com
      const result = await exec(command);
      let publicIP = result.stdout.split("\n")[0];
      if(publicIP) {
        log.info(`Found public IP (opendns) is ${publicIP}`);
      }

      if(publicIP === "") {
        if(this.publicIPAPI) {
          try {
            const result = await rp({
              uri: this.publicIPAPI,
              json: true
            });
            if(result && result.ip) {
              publicIP = result.ip;
              log.info(`Found public IP from ${this.publicIPAPI} is ${publicIP}`);
            }
          } catch(err) {
            log.error("Failed to get public ip, err:", err);
          }

        }
      }

      let existingPublicIPJSON = await rclient.hgetAsync(redisKey, redisHashKey);
      let existingPublicIP = JSON.parse(existingPublicIPJSON);
      if(publicIP !== existingPublicIP) {
        await rclient.hsetAsync(redisKey, redisHashKey, JSON.stringify(publicIP));
        sem.emitEvent({
          type: "PublicIP:Updated",
          ip: publicIP
        }); // local event within FireMain
        sem.emitEvent({
          type: "PublicIP:Updated",
          ip: publicIP,
          toProcess: 'FireApi'
        });
      }
    } catch(err) {
      log.error("Failed to query public ip:", err);
    }
  }

  async run() {
    this.publicIPAPI = this.config.publicIPAPI || "https://api.ipify.org?format=json";
    this.scheduleRunJob();

    sem.on("PublicIP:Check", (event) => {
      this.scheduleRunJob();
    });

    setInterval(() => {
      this.scheduleRunJob();
    }, this.config.interval * 1000 || 1000 * 60 * 60 * 2); // check every 2 hrs

    sclient.on("message", (channel, message) => {
      if (channel === Message.MSG_SYS_NETWORK_INFO_RELOADED) {
        log.info("Schedule reload PublicIPSensor since network info is reloaded");
        this.scheduleRunJob();
      }
    });
    sclient.subscribe(Message.MSG_SYS_NETWORK_INFO_RELOADED);
  }

  scheduleRunJob() {
    if (this.reloadTask)
      clearTimeout(this.reloadTask);
    this.reloadTask = setTimeout(() => {
      this.job();
    }, 10000);
  }
}

module.exports = PublicIPSensor;
