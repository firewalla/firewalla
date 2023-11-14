/*    Copyright 2016-2023 Firewalla Inc.
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

const exec = require('child-process-promise').exec;
const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');
const extensionManager = require('./ExtensionManager.js')
const rclient = require('../util/redis_manager.js').getRedisClient();
const rclient1 = require('../util/redis_manager.js').getRedisClientWithDB1();
const sysManager = require('../net2/SysManager.js');
const sem = require('./SensorEventManager.js').getInstance();
const Message = require('../net2/Message.js');

const era = require('../event/EventRequestApi.js');
const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();

const FireRouter = require('../net2/FireRouter.js');

const _ = require('lodash');
const Constants = require('../net2/Constants.js');

const FEATURE_DEVICE_MONITOR = "device_monitor";

// dm stands for device monitor
const KEY_DEVICE_MONITOR_PREFIX = "dm:host:"
const KEY_AP_STA_STATUS = "assets:ap_sta_status";

const MONITOR_INTERVAL=15 * 1000;
const POLICY_KEYNAME = "dm";

class DeviceMonitorSensor extends Sensor {

  constructor(config) {
    super(config)
    this.adminSwitch = false;
    this.selectedDevices = {};
  }

  async globalOn() {
    log.info("run globalOn ...");
    this.adminSwitch = true;
  }

  async globalOff() {
    log.info("run globalOff ...");
    this.adminSwitch = false;
  }

  async run() {

    log.info("run Device Monitor Sensor ...");

    this.hookFeature(FEATURE_DEVICE_MONITOR);

    /*
     * apply policy upon policy change or startup
     */
    extensionManager.registerExtension(POLICY_KEYNAME, this, {
      applyPolicy: this.applyPolicy,
    });

    setInterval(this.job.bind(this), MONITOR_INTERVAL);
  }

  async job() {
    log.info("Running device monitor job...");
    for (const device of Object.keys(this.selectedDevices)) {
      await this.monitorDevice(device);
    }
  }

  async applyPolicy(host, ip, policy) {
    log.info("Applying dm policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        // do nothing
      } else {
        if (!host)
          return;
        switch (host.constructor.name) {
        case "Tag": {
        // do nothing
          break;
        }
        case "NetworkProfile": {
        // do nothing
          break;
        }
        case "Host": {
          const macAddress = host && host.o && host.o.mac;
          if (macAddress) {
            if (policy === true) {
              log.info("Start monitoring device", macAddress);
              this.selectedDevices[macAddress] = 1;
            } else {
              log.info("Stop monitoring device", macAddress);
              delete this.selectedDevices[macAddress];
            }
          }
          break;
        }
        default:
          // do nothing
        }
      }
    } catch (err) {
      log.error("Got error when applying dm policy", err);
    }
  }

  async monitorDevice(mac) {
    log.info("Monitor device", mac);
    try {
      const statsStr = await rclient1.hgetAsync(KEY_AP_STA_STATUS, mac);
      if (statsStr) {
        const {snr, bssid} = JSON.parse(statsStr);
        const ts = Math.floor(new Date() / 1000);
        const newData = {snr, bssid, ts};
        const key = `${KEY_DEVICE_MONITOR_PREFIX}${mac}`;
        await rclient.zaddAsync(key, Math.floor(new Date() / 1000), JSON.stringify(newData));
      }
    } catch (e) {
      log.error(`failed to monitor device ${mac}, error: ${e}`);
    }
  }

  async apiRun(){
    extensionManager.onGet("deviceMonitorData", async (msg,data) => {
      // return await this.getNetworkMonitorData();
    });

    extensionManager.onGet("staStatus", async (msg,data) => {
      try {
        const mac = data.mac;
        const status = await FireRouter.getSTAStatus(mac);
        return status;
      } catch(err) {
        log.error("Got error when getting status for mac", mac, err);
      }
    });
  }

}

module.exports = DeviceMonitorSensor;
