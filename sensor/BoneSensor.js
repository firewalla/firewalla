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

const Bone = require('../lib/Bone');

const extensionManager = require('./ExtensionManager.js')

const Sensor = require('./Sensor.js').Sensor;

const serviceConfigKey = "bone:service:config";

const syncInterval = 1000 * 3600 * 4; // sync every 4 hours
const rclient = require('../util/redis_manager.js').getRedisClient()

const sysManager = require('../net2/SysManager.js');

const License = require('../util/license');

const fConfig = require('../net2/config.js').getConfig();

const sem = require('../sensor/SensorEventManager.js').getInstance();

const execAsync = require('child-process-promise').exec

const mode = require('../net2/Mode.js');
let HostManager = require('../net2/HostManager.js');
let hostManager = new HostManager();

const CLOUD_URL_KEY = "sys:bone:url";
const FORCED_CLOUD_URL_KEY = "sys:bone:url:forced";


class BoneSensor extends Sensor {
  scheduledJob() {
    Bone.waitUntilCloudReady(() => {
      this.checkIn()
        .then(() => { })
        .catch((err) => {
          log.error("Failed to check in", err);
        })

    })
  }

  apiRun() {
    // register get/set handlers for fireapi
    extensionManager.onGet("cloudInstance", async (msg) => {
      return this.getCloudInstanceURL();
    })

    extensionManager.onGet("boneJWToken", async (msg) => {
      const jwt = await rclient.getAsync("sys:bone:jwt");
      return { jwt };
    })

    extensionManager.onSet("cloudInstance", async (msg, data) => {
      if (data.instance) {
        const url = `https://firewalla.encipher.io/bone/api/${data.instance}`;
        return this.setCloudInstanceURL(url);
      }
    })

    extensionManager.onCmd("recheckin", async (msg, data) => {

      return new Promise((resolve, reject) => {

        sem.once("CloudReCheckinComplete", async (event) => {
          const jwt = await rclient.getAsync("sys:bone:jwt");
          resolve({ jwt });
        });

        sem.sendEventToFireMain({
          type: 'CloudReCheckin',
          message: "",
        });
      });
    });
  }

  async getCloudInstanceURL() {
    return rclient.getAsync(CLOUD_URL_KEY);
  }

  async getForcedCloudInstanceURL() {
    return rclient.getAsync(FORCED_CLOUD_URL_KEY);
  }

  async setCloudInstanceURL(url) {
    const curUrl = await this.getCloudInstanceURL();
    if (curUrl === url) {
      return;
    }

    log.info(`Applying new cloud url: ${url}`);

    await rclient.setAsync(CLOUD_URL_KEY, url);
    sem.emitEvent({
      type: 'CloudURLUpdate',
      toProcess: 'FireMain',
      message: "",
      url: url
    });
  }

  async setForcedCloudInstanceURL(url) {
    const curUrl = await this.getCloudInstanceURL();
    if (curUrl === url) {
      return;
    }

    log.info(`Applying new forced cloud url: ${url}`);

    await rclient.setAsync(FORCED_CLOUD_URL_KEY, url);

    return this.setCloudInstanceURL(url);
  }

  async applyNewCloudInstanceURL() {
    const curUrl = await this.getCloudInstanceURL();

    log.info(`Applying new cloud server url ${curUrl}`);

    return this.checkIn();
  }
  async countTotal() {
    return {
      totalAlarms: await rclient.getAsync("alarm:id"),
      totalRules: await rclient.getAsync("policy:id"),
      totalExceptions: await rclient.getAsync("exception:id")
    }
  }

  async checkIn() {
    const url = await this.getForcedCloudInstanceURL();

    if (url) {
      Bone.setEndpoint(url);
    }

    const license = License.getLicense();

    if (!license) {
      log.error("License file is required!");
      // return Promise.resolve();
    }

    let sysInfo = await sysManager.getSysInfoAsync();
    Object.assign(sysInfo, await this.countTotal());

    log.debug("Checking in Cloud...", sysInfo);

    // First checkin usually have no meaningful data ...
    //
    try {
      if (this.lastCheckedIn && this.iptablesReady) {
        // HostManager.getCheckIn will call getHosts, which should be called after iptables is ready
        let HostManager = require("../net2/HostManager.js");
        let hostManager = new HostManager();
        sysInfo.hostInfo = await hostManager.getCheckInAsync();
      }
    } catch (e) {
      log.error("BoneCheckIn Error fetching hostInfo", e);
    }

    const data = await Bone.checkinAsync(fConfig, license, sysInfo);
    await this.checkCloudSpoofOff(data.spoofOff);
    this.lastCheckedIn = Date.now() / 1000;

    log.info("Cloud checked in successfully:")//, JSON.stringify(data));

    await rclient.setAsync("sys:bone:info", JSON.stringify(data));

    const existingDDNS = await rclient.hgetAsync("sys:network:info", "ddns");
    if (data.ddns) {
      sysManager.ddns = data.ddns;
      await rclient.hsetAsync(
        "sys:network:info",
        "ddns",
        JSON.stringify(data.ddns)); // use JSON.stringify for backward compatible
    }

    let existingPublicIP = await rclient.hgetAsync("sys:network:info", "publicIp");
    if (data.publicIp) {
      sysManager.publicIp = data.publicIp;
      await rclient.hsetAsync(
        "sys:network:info",
        "publicIp",
        JSON.stringify(data.publicIp)); // use JSON.stringify for backward compatible
    }

    // broadcast new change
    if (existingDDNS !== JSON.stringify(data.ddns) ||
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
        execAsync('sync & /home/pi/firewalla/scripts/fireupgrade.sh soft')
      } else if (data.upgrade.type == "hard") {
        log.info("Bone:Upgrade:Hard", data.upgrade);
        execAsync('sync & /home/pi/firewalla/scripts/fireupgrade.sh hard')
      }
    }

    if (data && data.frpToken) {
      await rclient.hsetAsync("sys:config", "frpToken", data.frpToken)
    }
  }

  async checkCloudSpoofOff(spoofOff) {
    let spoofMode = await mode.isSpoofModeOn();
    const spoofOffKey = 'sys:bone:spoofOff';
    if (spoofOff && spoofMode) {
      await rclient.setAsync(spoofOffKey, spoofOff);
      //turn off simple mode
      hostManager.spoof(false);
    } else {
      const redisSpoofOff = await rclient.getAsync(spoofOffKey);
      if (redisSpoofOff) {
        await rclient.delAsync(spoofOffKey);
        if (spoofMode) {
          hostManager.spoof(true);
        }
      }
    }
  }

  run() {
    setInterval(() => {
      this.scheduledJob();
    }, syncInterval);

    sem.on("CloudURLUpdate", async () => {
      return this.applyNewCloudInstanceURL()
    })

    sem.on("PublicIP:Updated", () => {
      this.checkIn();
    });

    sem.once("IPTABLES_READY", () => {
      this.iptablesReady = true;
    });

    sem.on("CloudReCheckin", async () => {
      try {
        await this.checkIn();
      } catch (err) {
        log.error('Failed to re-checkin to cloud', err)
      }

      sem.sendEventToFireApi({
        type: 'CloudReCheckinComplete',
        message: ""
      });
    });
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

      if (config && config.constructor.name === 'Object') {
        rclient.hmsetAsync(serviceConfigKey, this.flattenConfig(config))
          .then(() => {
            log.info("Service config is updated");
          }).catch((err) => {
            log.error("Failed to store service config in redis:", err);
          })
      }
    })
  }
}

module.exports = BoneSensor;
