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

const sem = require('../sensor/SensorEventManager.js').getInstance();

const rclient = require('../util/redis_manager.js').getRedisClient()
const Message = require('../net2/Message.js');
const sysManager = require('../net2/SysManager.js');

const exec = require('child-process-promise').exec;

const { rrWithErrHandling } = require('../util/requestWrapper.js')

const command = "dig +short myip.opendns.com @resolver1.opendns.com";
const redisKey = "sys:network:info";
const redisHashKey = "publicIp";
const publicWanIPsHashKey = "publicWanIps";

const _ = require('lodash');

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
            const result = await rrWithErrHandling({
              uri: this.publicIPAPI,
              json: true
            });
            if(result.body && result.body.ip) {
              publicIP = result.body.ip;
              log.info(`Found public IP from ${this.publicIPAPI} is ${publicIP}`);
            }
          } catch(err) {
            log.error("Failed to get public ip, err:", err);
          }

        }
      }

      // TODO: support v6
      const publicWanIps = sysManager.filterPublicIp4(sysManager.myWanIps(true).v4).sort();
      const existingPublicWanIpsJSON = await rclient.hgetAsync(redisKey, publicWanIPsHashKey);
      const existingPublicWanIps = ((existingPublicWanIpsJSON && JSON.parse(existingPublicWanIpsJSON)) || []).sort();

      // connected public WAN IP overrides public IP from http request, this is mainly used in load-balance mode
      if (publicWanIps.length > 0) {
        if (!publicIP  || !publicWanIps.includes(publicIP)) {
          publicIP = publicWanIps[0];
        }
      }

      let existingPublicIPJSON = await rclient.hgetAsync(redisKey, redisHashKey);
      let existingPublicIP = JSON.parse(existingPublicIPJSON);
      if(publicIP !== existingPublicIP || !_.isEqual(publicWanIps, existingPublicWanIps)) {
        await rclient.hsetAsync(redisKey, redisHashKey, JSON.stringify(publicIP));
        await rclient.hsetAsync(redisKey, publicWanIPsHashKey, JSON.stringify(publicWanIps));
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
    await sysManager.waitTillInitialized();
    this.publicIPAPI = this.config.publicIPAPI || "https://api.ipify.org?format=json";
    this.scheduleRunJob();

    sem.on("PublicIP:Check", (event) => {
      this.scheduleRunJob();
    });

    setInterval(() => {
      this.scheduleRunJob();
    }, this.config.interval * 1000 || 1000 * 60 * 60 * 2); // check every 2 hrs

    sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, () => {
      log.info("Schedule reload PublicIPSensor since network info is reloaded");
      this.scheduleRunJob();
    })
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
