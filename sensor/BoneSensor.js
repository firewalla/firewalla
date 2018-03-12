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

let log = require('../net2/logger.js')(__filename);

let Bone = require('../lib/Bone');

let Sensor = require('./Sensor.js').Sensor;

let serviceConfigKey = "bone:service:config";

let syncInterval = 1000 * 3600 * 4; // sync every 4 hourly
const rclient = require('../util/redis_manager.js').getRedisClient()
const Promise = require('bluebird');

let SysManager = require('../net2/SysManager.js');
let sysManager = new SysManager('info');

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let License = require('../util/license');

let fConfig = require('../net2/config.js').getConfig();

let sem = require('../sensor/SensorEventManager.js').getInstance();


class BoneSensor extends Sensor {
  scheduledJob() {
    Bone.waitUtilCloudReady(() => {
      this.checkIn()
        .then(() => {})
        .catch((err) => {
        log.error("Failed to check in", err, {});
        })

    })
  }

  checkIn() {
    let license = License.getLicense();

    if(!license) {
      log.error("License file is required!");
      // return Promise.resolve();
    }

    return async(() => {
      let sysInfo = await (sysManager.getSysInfoAsync());

      log.debug("Checking in Cloud...",sysInfo,{});
 
      // First checkin usually have no meaningful data ... 
      //
      try {
        if (this.lastCheckedIn) {
            let HostManager = require("../net2/HostManager.js");
            let hostManager = new HostManager("cli", 'server', 'info');
            sysInfo.hostInfo = await (hostManager.getCheckInAsync());
        }
      } catch (e) {
        log.error("BoneCheckIn Error fetching hostInfo",e,{});
      }

      let data = await (Bone.checkinAsync(fConfig, license, sysInfo));

      this.lastCheckedIn = Date.now() / 1000;

      log.info("Cloud checked in successfully:")//, JSON.stringify(data));

      await (rclient.setAsync("sys:bone:info",JSON.stringify(data)));

      let existingDDNS = await (rclient.hgetAsync("sys:network:info", "ddns"));
      if (data.ddns) {
        sysManager.ddns = data.ddns;
        await (rclient.hsetAsync(
          "sys:network:info",
          "ddns",
          JSON.stringify(data.ddns))); // use JSON.stringify for backward compatible
      }

      let existingPublicIP = await (rclient.hgetAsync("sys:network:info", "publicIp"));
      if(data.publicIp) {
        sysManager.publicIp = data.publicIp;
        await (rclient.hsetAsync(
          "sys:network:info",
          "publicIp",
          JSON.stringify(data.publicIp))); // use JSON.stringify for backward compatible
      }

      // broadcast new change
      if(existingDDNS !== JSON.stringify(data.ddns) ||
      existingPublicIP !== JSON.stringify(data.publicIp)) {
        sem.emitEvent({
          type: 'DDNS:Updated',
          toProcess: 'FireApi',
          publicIp: data.publicIp,
          ddns: data.ddns,
          message: 'DDNS is updated'
        })
      }

      if (data && data.upgrade) {
          log.info("Bone:Upgrade", data.upgrade);
          if (data.upgrade.type == "soft") {
             log.info("Bone:Upgrade:Soft", data.upgrade);
             require('child_process').exec('sync & /home/pi/firewalla/scripts/fireupgrade.sh soft', (err, out, code) => {
             });
          } else if (data.upgrade.type == "hard") {
             log.info("Bone:Upgrade:Hard", data.upgrade);
             require('child_process').exec('sync & /home/pi/firewalla/scripts/fireupgrade.sh hard', (err, out, code) => {
             });
          }
      }

      if (data && data.frpToken) {
        await (rclient.hsetAsync("sys:config", "frpToken", data.frpToken))
      }
    })();
  }

  run() {
    // setTimeout(() => {
    //   this.scheduledJob();
    // }, 5 * 1000); // in 5 seconds

    setInterval(() => {
      this.scheduledJob();
    }, syncInterval);
  }

  // make config redis-friendly..
  flattenConfig(config) {
    let sConfig = {};

    let keys = ["adblock.dns", "family.dns"];

    keys.filter((key) => config[key]).forEach((key) => {
      if (config[key].constructor.name === 'Object' ||
        config[key].constructor.name === 'Array') {
        sConfig[key] = JSON.stringify(config[key]);
      } else {
        sConfig[key] = config[key];
      }
    })

    return sConfig;
  }

  loadServiceConfig() {
    log.info("Loading service config from cloud...");
    Bone.getServiceConfig((err, config) => {

      if(config && config.constructor.name === 'Object') {
        rclient.hmsetAsync(serviceConfigKey, this.flattenConfig(config))
          .then(() => {
            log.info("Service config is updated");
          }).catch((err) => {
          log.error("Failed to store service config in redis:", err, {});
        })
      }
    })
  }
}

module.exports = BoneSensor;
