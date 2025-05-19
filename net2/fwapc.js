/*    Copyright 2019-2025 Firewalla Inc.
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

const log = require("./logger.js")(__filename);

const f = require('../net2/Firewalla.js');
const PlatformLoader = require('../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()
const Config = require('./config.js')
const sem = require('../sensor/SensorEventManager.js').getInstance();
const { rrWithErrHandling } = require('../util/requestWrapper.js')

const util = require('util')
const rp = util.promisify(require('request'))
const _ = require('lodash');
const sysManager = require('./SysManager.js');
const Message = require('./Message.js');
const Constants = require("./Constants.js");
const fsp = require('fs').promises;
const exec = require('child-process-promise').exec;
const {fileExist, fileRemove} = require('../util/util.js');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_FWAPC_RULE = "LOCK_FWAPC_RULE";

// not exposing these methods/properties
async function localGet(endpoint, retry = 5) {
  if (!platform.isFireRouterManaged())
    throw new Error('Forbidden')

  const response = await rrWithErrHandling({
    uri: fwapcInterface + endpoint,
    method: "GET",
    maxAttempts: retry,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
    json: true,
  })

  return response.body
}

async function localSet(endpoint, body, retry = 5) {
  if (!platform.isFireRouterManaged())
    throw new Error('Forbidden')

  const response = await rrWithErrHandling({
    uri: fwapcInterface + endpoint,
    method: "POST",
    maxAttempts: retry,   // (default) try 5 times
    retryDelay: 1000,  // (default) wait for 1s before trying again
    json: body,
  })

  return response.body
}

async function getConfig() {
  return localGet("/config/active")
}

// the config can only be set at FireRouter

// async function setConfig(config) {
//   return localSet("/config/set", config)
// }

async function getWANInterfaces() {
  return localGet("/config/wans")
}

async function getLANInterfaces() {
  return localGet("/config/lans")
}

async function getInterfaces() {
  return localGet("/config/interfaces")
}

async function getInterface(intf) {
  return localGet(`/config/interfaces/${intf}`, 2)
}

// internal properties
let fwapcInterface = null
let staStatus = null
let staStatusTs = 0;

class FWAPC {
  constructor() {
    log.info(`platform is: ${platform.constructor.name}`);

    const fwConfig = Config.getConfig();

    if (!fwConfig.fwapc || !fwConfig.fwapc.interface) return null

    const intf = fwConfig.fwapc.interface;
    fwapcInterface = `http://${intf.host}:${intf.port}/${intf.version}`;

    if (f.isMain()) {
      this.enabled = false;
      this.toggleFWAPC();
      sem.on(Message.MSG_SYS_NETWORK_INFO_RELOADED, async (event) => {
        this.toggleFWAPC();
      });
    }
  }

  async toggleFWAPC() {
    // enable disable fwapc auto update in assets framework based on wg_ap interface presence
    // always enable fwapc service
    if ((true || sysManager.getInterface(Constants.INTF_AP_CTRL))) {
      if (!this.enabled) {
        this.enableFWAPC().catch((err) => {
          log.error("Failed to enable fwapc", err.message);
        });
      }
      this.enabled = true;
    } else {
      this.disableFWAPC().catch((err) => {
        log.error("Failed to disable fwapc", err.message);
      });
      this.enabled = false;
    }
  }

  async enableFWAPC() {
    await fsp.mkdir(`${f.getUserConfigFolder()}/assets.fwapc`, {recursive: true}).catch((err) => {});
    const fwapcAssetsDir = `${f.getUserConfigFolder()}/assets.fwapc`;
    await fsp.copyFile(`${platform.getPlatformFilesPath()}/01_assets_fwapc.lst`, `${fwapcAssetsDir}/01_assets_fwapc.lst`);
    if (!await fileExist(`${f.getRuntimeInfoFolder()}/assets/fwapc`)) {
      await exec(`ASSETSD_PATH=${fwapcAssetsDir} ${f.getFirewallaHome()}/scripts/update_assets.sh`).catch((err) => {
        log.error(`Failed to invoke update_assets.sh`, err.message);
      });
    }
    await exec(`sudo systemctl start fwapc`).catch((err) => {
      log.error(`Failed to start fwapc.service`, err.message);
    });
    await this.addCronJobs();
  }

  async disableFWAPC() {
    const assetsLstPath = `${f.getUserConfigFolder()}/assets.fwapc/01_assets_fwapc.lst`;
    if (await fileExist(assetsLstPath))
      await fileRemove(assetsLstPath);
    await exec(`sudo systemctl stop fwapc`).catch((err) => {
      log.error(`Failed to start fwapc.service`, err.message);
    });
    await this.removeCronJobs();
  }

  async addCronJobs() {
    log.info("Adding fwapc update cron jobs");
    await fsp.unlink(`${f.getUserConfigFolder()}/fwapc_crontab`).catch((err) => {});
    await fsp.symlink(`${f.getFirewallaHome()}/etc/crontab.fwapc`, `${f.getUserConfigFolder()}/fwapc_crontab`).catch((err) => {});
    await exec(`${f.getFirewallaHome()}/scripts/update_crontab.sh`).catch((err) => {
      log.error(`Failed to invoke update_crontab.sh in addCronJobs`, err.message);
    });
  }

  async removeCronJobs() {
    log.info("Removing fwapc update cron jobs");
    await fsp.unlink(`${f.getUserConfigFolder()}/fwapc_crontab`).catch((err) => {});
    await exec(`${f.getFirewallaHome()}/scripts/update_crontab.sh`).catch((err) => {
      log.error(`Failed to invoke update_crontab.sh in removeCronJobs`, err.message);
    });
  }

  async getGroupStatus(groupId) {
    const groupStatus = await localGet(`/status/group/${groupId}`).catch((err) => {
      log.error(`Failed to get group status of ${groupId}`, err.message);
      return null;
    });
    return groupStatus;
  }

  async getAllSSIDStatus() {
    const ssidStatus = await localGet("/status/ssid").then(resp => resp.info);
    return ssidStatus;
  }

  async getAllSTAStatus(live = false) {
    if (live || Date.now() / 1000 - staStatusTs > 15) {
      staStatus = await localGet("/status/station", 1).then(resp => resp.info);
      staStatusTs = Date.now() / 1000;
    }
    return Object.assign({}, staStatus);
  }

  async getSTAStatus(mac) {
    return localGet(`/status/station/${mac}`, 1).then(resp => resp && resp.info);
  }

  async getAssetsStatus() {
    return localGet("/status/ap", 1).then(resp => resp.info);
  }

  async getControllerInfo() {
    return localGet("/info", 1).then(resp => resp.info);
  }

  async getPairingStatus() {
    return localGet("/runtime/pairing_stat", 1);
  }

  async getConfig() {
    return localGet("/config/active", 1);
  }

  async getCheckInData() {
    return localGet("/status/checkin_data");
  }

  async staBssSteer(staMAC, targetAP, targetSSID, targetBand) {
    const options = {
      method: "POST",
      headers: {
        "Accept": "application/json"
      },
      url: fwapcInterface + "/ap/bss_steer",
      json: true,
      body: {
        staMAC, targetAP, targetSSID, targetBand
      }
    };
    const resp = await rp(options);
    return {code: resp.statusCode, body: resp.body};
  }

  async apiCall(method, path, body) {
    const options = {
      method: method,
      headers: {
        "Accept": "application/json"
      },
      url: fwapcInterface + path,
      json: true
    };

    if(body) {
      options.body = body;
    }
    try {
      const resp = await rp(options);
      let r =  {code: resp.statusCode, body: resp.body};
      if (resp.statusCode === 500) {
        r.msg = resp.body;
      }
      return r;
    } catch (e) {
      return {code: 500, msg: e.message};
    }
  }

  async setGroup(groupId, data) {
    if (!groupId)
      throw new Error("groupId is not defined in setGroup");
    if (!_.isObject(data))
      throw new Error("data should be an object in setGroup");
    const payload = _.pick(data, ["macs", "config"]);
    const {code, body, msg} = await this.apiCall("POST", `/config/group/${groupId}`, payload);
    if (!isNaN(code) && Number(code) > 299) {
      throw new Error(msg || "Failed to set group in fwapc");
    }
    return;
  }

  async deleteGroup(groupId, optKey = null) {
    if (!groupId)
      throw new Error("groupId is not defined in deletGroup");
    const {code, body, msg} = await this.apiCall("DELETE", `/config/group/${groupId}${optKey ? `/${optKey}` : ""}`);
    if (!isNaN(code) && Number(code) > 299) {
      throw new Error(msg || "Failed to delete group in fwapc");
    }
    return;
  }

  async updateRules(rules, fullSync = false) {
    await lock.acquire(LOCK_FWAPC_RULE, async () => {
      const {code, body, msg} = await this.apiCall("POST", "/config/rules", {rules, full_sync: fullSync});
      if (!isNaN(code) && Number(code) > 299) {
        throw new Error(msg || "Failed to delete group in fwapc");
      }
    }).catch((err) => {
      log.error(`Failed to update rules, fullSync: ${fullSync}`, err.message);
    });
  }

  async updateRule(rule) {
    if (!rule.pid) {
      log.error(`pid is not defined in rule`, rule);
      return;
    }
    await lock.acquire(LOCK_FWAPC_RULE, async () => {
      const {code, body, msg} = await this.apiCall("PUT", `/config/rules/${rule.pid}`, rule);
      if (!isNaN(code) && Number(code) > 299) {
        throw new Error(msg || "Failed to delete group in fwapc");
      }
    }).catch((err) => {
      log.error(`Failed to update rule`, rule, err.message);
    });
  }

  async deleteRule(pid) {
    await lock.acquire(LOCK_FWAPC_RULE, async () => {
      const {code, body, msg} = await this.apiCall("DELETE", `/config/rules/${pid}`);
      if (!isNaN(code) && Number(code) > 299) {
        throw new Error(msg || "Failed to delete group in fwapc");
      }
    }).catch((err) => {
      log.error(`Failed to delete rule, pid: ${pid}`, err.message);
    });
  }

  async setDeviceAcl(mac, data) {
    if (!mac)
      throw new Error("mac is not defined in setDeviceAcl");
    if (!_.isObject(data))
      throw new Error("data should be an object in setDeviceAcl");
    const payload = _.pick(data, ["isolation"]);
    const {code, body, msg} = await this.apiCall("POST", `/config/device_acl/${mac.toUpperCase()}`, data);
    if (!isNaN(code) && Number(code) > 299)
      throw new Error(msg || "Failed to set DeviceAcl")
    return;
  }

  async deleteDeviceAcl(mac) {
    if (!mac)
      throw new Error("mac is not defined in deleteDeviceAcl");
    const {code, body, msg} = await this.apiCall("DELETE", `/config/device_acl/${mac.toUpperCase()}`);
    if (!isNaN(code) && Number(code) > 299) {
      throw new Error(msg || "Failed to delete device acl in fwapc");
    }
    return;
  }
}

const instance = new FWAPC();
module.exports = instance;
