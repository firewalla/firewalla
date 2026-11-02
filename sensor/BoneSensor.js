/*    Copyright 2016-2025 Firewalla Inc.
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
const cloudWrapper = require('../net2/FWCloudWrapper.js');

const extensionManager = require('./ExtensionManager.js')

const Sensor = require('./Sensor.js').Sensor;

const serviceConfigKey = "bone:service:config";

const rclient = require('../util/redis_manager.js').getRedisClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const sysManager = require('../net2/SysManager.js');

const License = require('../util/license');

const fc = require('../net2/config.js')

const sem = require('../sensor/SensorEventManager.js').getInstance();

const execAsync = require('child-process-promise').exec
const _ = require('lodash');

const mode = require('../net2/Mode.js');
let HostManager = require('../net2/HostManager.js');
let hostManager = new HostManager();
const Message = require('../net2/Message.js');
const Constants = require('../net2/Constants.js');

const CLOUD_URL_KEY = "sys:bone:url";
const FORCED_CLOUD_URL_KEY = "sys:bone:url:forced";

const DEFAULT_EPT_TOKEN_REFRESH_ADVANCE = 30 * 24 * 3600; // refresh 30d before expiry

// read `exp` (unix sec) from an ept token without verifying; null if not a JWT
function decodeTokenExp(token) {
  if (!token || typeof token !== 'string')
    return null;
  const parts = token.split('.');
  if (parts.length < 2)
    return null;
  try {
    // base64url -> base64 (Node 12 can't decode base64url)
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return _.isNumber(payload.exp) ? payload.exp : null;
  } catch (err) {
    return null;
  }
}


class BoneSensor extends Sensor {
  scheduledJob() {
    if (!this.checkinTask) {
      log.info(`Next scheduled checkin will happen in ${this.nextInterval} milliseconds`);
      this.checkinTask = setTimeout(() => {
        Bone.waitUntilCloudReady(() => {
          this.checkIn().then(() => {
            log.info("Scheduled checkin succeeded");
          }).catch((err) => {
            log.error("Scheduled checkin failed", err);
          }).then(() => {
            this.nextInterval = Math.min(this.nextInterval * 2, (this.config.checkInMaxInterval || 3600 * 4) * 1000);
            this.checkinTask = null;
            this.scheduledJob();
          });
        });
      }, this.nextInterval);
    }
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
      totalExceptions: await rclient.getAsync("exception:id"),
      activeAlarms: await rclient.zcountAsync("alarm_active", '-inf', '+inf'),
      activeRules: await rclient.zcountAsync("policy_active", '-inf', '+inf'),
      activeExceptions: await rclient.scardAsync("exception_queue")
    }
  }

  // Refresh sys:ept before the ept token expires, so checkin never hits an expired one.
  async refreshEptTokenIfNeeded() {
    const token = await rclient.hgetAsync("sys:ept", "token");
    const exp = decodeTokenExp(token);
    if (!exp) // not a JWT; rely on the reactive 401 path in checkIn
      return;

    const advance = this.config.eptTokenRefreshAdvance || DEFAULT_EPT_TOKEN_REFRESH_ADVANCE;
    const now = Date.now() / 1000;
    if (exp - now > advance)
      return;

    log.warn(`ept token expires in ${Math.round((exp - now) / 86400)} day(s), refreshing`);
    await cloudWrapper.refreshToken();
    await Bone.checkCloud(); // let Bone pick up the fresh token now
  }

  async checkIn(useOriginalEndpoint = false) {
    await this.refreshEptTokenIfNeeded().catch((err) => {
      log.error("Failed to proactively refresh ept token", err);
    });

    const url = await this.getForcedCloudInstanceURL();

    if (url) {
      log.warn("FORCED USING CLOUD INSTANCE:", url);
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
      if (this.lastCheckedIn && sysManager.isIptablesReady()) {
        // HostManager.getCheckIn will call getHosts, which should be called after iptables is ready
        let HostManager = require("../net2/HostManager.js");
        let hostManager = new HostManager();
        sysInfo.hostInfo = await hostManager.getCheckInAsync();
        if (sysInfo.hostInfo.model) {
          rclient.setAsync("model", sysInfo.hostInfo.model); // no need to await, this info is used by other processes, e.g. firerouter
        }
      }
    } catch (e) {
      log.error("BoneCheckIn Error fetching hostInfo", e);
    }

    let data;
    try {
      data = await Bone.checkinAsync(fc.getConfig().version, license, sysInfo, useOriginalEndpoint);
    } catch (err) {
      // expired ept token -> cloud rejects; refresh and retry once
      if (err && (err.statusCode === 401 || err.statusCode === 403)) {
        log.warn("Checkin rejected with", err.statusCode, "- refreshing ept token and retrying");
        await cloudWrapper.refreshToken();
        await Bone.checkCloud(); // pick up fresh token before retry
        data = await Bone.checkinAsync(fc.getConfig().version, license, sysInfo, useOriginalEndpoint);
      } else {
        throw err;
      }
    }
    this.lastCheckedIn = Date.now() / 1000;

    log.info("Cloud checked in successfully")//, JSON.stringify(data));

    // no action for empty response
    if (data) {
      await this.checkCloudSpoofOff(data.spoofOff);

      await rclient.setAsync("sys:bone:info", JSON.stringify(data));
      await rclient.delAsync(Constants.REDIS_KEY_DDNS_UPDATE); // always remove ddns:update object after check-in

      const existingDDNS = await rclient.hgetAsync("sys:network:info", "ddns");
      if (data.ddns) {
        sysManager.ddns = data.ddns;
        await rclient.hsetAsync(
          "sys:network:info",
          "ddns",
          JSON.stringify(data.ddns)); // use JSON.stringify for backward compatible
      }

      if (data.ddnsToken) {
        sysManager.ddnsToken = data.ddnsToken;
        await rclient.hsetAsync("sys:network:info", "ddnsToken", JSON.stringify(data.ddnsToken));
      }

      let existingPublicIP = await rclient.hgetAsync("sys:network:info", "publicIp");
      if (data.publicIp && data.publicIp !== "0.0.0.0") { // 0.0.0.0 will be returned from cloud if ddns is disabled, it is not an effective IP address
        sysManager.publicIp = data.publicIp;
        await rclient.hsetAsync(
          "sys:network:info",
          "publicIp",
          JSON.stringify(data.publicIp)); // use JSON.stringify for backward compatible
      }

      // broadcast new change
      if (existingDDNS !== JSON.stringify(data.ddns) ||
        data.publicIp !== "0.0.0.0" && existingPublicIP !== JSON.stringify(data.publicIp)) {
        sem.emitEvent({
          type: 'DDNS:Updated',
          toProcess: 'FireApi',
          publicIp: data.publicIp,
          ddns: data.ddns,
          message: 'DDNS is updated'
        })
      }

      if (data.upgrade) {
        log.info("Bone:Upgrade", data.upgrade);
        if (data.upgrade.type == "soft") {
          log.info("Bone:Upgrade:Soft", data.upgrade);
          execAsync('sync & /home/pi/firewalla/scripts/fireupgrade.sh soft')
        } else if (data.upgrade.type == "hard") {
          log.info("Bone:Upgrade:Hard", data.upgrade);
          execAsync('sync & /home/pi/firewalla/scripts/fireupgrade.sh hard')
        }
      }

      if (data.frpToken) {
        await rclient.hsetAsync("sys:config", "frpToken", data.frpToken)
      }

      if (data.cloudConfig) {
        await pclient.publishAsync('config:cloud:updated', JSON.stringify(data.cloudConfig))
      }

    } else {
      log.error('Empty response from check-in, something is wrong')
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
        await rclient.unlinkAsync(spoofOffKey);
        if (spoofMode) {
          hostManager.spoof(true);
        }
      }
    }
  }

  run() {
    // checkin interval increases exponentially from min to max
    this.nextInterval = (this.config.checkInMinInterval || 900) * 1000;
    this.scheduledJob();

    sem.on("CloudURLUpdate", async () => {
      return this.applyNewCloudInstanceURL()
    })

    sem.on("PublicIP:Updated", () => {
      this.checkIn();
    });

    sem.on(Message.MSG_LICENSE_UPDATED, () => {
      this.checkIn(true); // force using original endpoint in case the endpoint was previously redirected to blackhole due to simultaneous license update 
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

    this.loadHashsetConfig();
    setInterval(() => {
      this.loadHashsetConfig();
    }, (this.config.hashsetConfigInterval || 24 * 3600) * 1000);
  }

  async loadHashsetConfig() {
    try {
      const result = await Bone.hashsetAsync('features:config')
      if (!_.isEmpty(JSON.stringify(result))) {
        await rclient.setAsync('sys:bone:config:features', result);
        await pclient.publishAsync('config:hashset:updated', result)
        log.info("Hashset config updated successfully");
      }
    } catch (err) {
      log.error("Failed to get hashset config", err);
    }
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
