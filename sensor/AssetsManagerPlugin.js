/*    Copyright 2016-2022 Firewalla Inc.
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
const extensionManager = require('./ExtensionManager.js')
const rclient = require('../util/redis_manager.js').getRedisClient();
const FireRouter = require('../net2/FireRouter.js');
const _ = require('lodash');

const ASSETS_INFO_KEY = "assets:info";

class AssetsManagerPlugin extends Sensor {

  async apiRun() {
    extensionManager.onCmd("assets:updateInfo", async (msg, data) => {
      await this.setInfo(data);
    });

    extensionManager.onCmd("assets:updateConfig", async (msg, data) => {
      await this.setAssetsConfig(data);
    });

    extensionManager.onCmd("assets:getInfo", async (msg, data) => {
      if (data.uid)
        return await this.getInfo(data.uid);
      else
        return await this.getInfo();
    });

    extensionManager.onCmd("assets:getConfig", async (msg, data) => {
      if (data.uid)
        return await this.getConfig(data.uid);
      else
        return await this.getConfig();
    });

    extensionManager.onCmd("assets:delete", async (msg, data) => {
      if (!data.uid)
        throw new Error(`uid should be specified`);
      await this.deleteConfig(data.uid);
      await this.deleteInfo(data.uid);
    });
  }

  async getConfig(uid) {
    let errMsg = null;
    const result = await FireRouter.getAssetsConfig(uid).catch((err) => {
      errMsg = err.message;
      return null;
    });
    if (errMsg)
      throw new Error(errMsg);
    if (result.code != 200) {
      errMsg = result.body && !_.isEmpty(result.body.errors) ? result.body.errors[0] : "Failed to get assets config";
      throw new Error(errMsg);
    }
    return result.body;
  }

  async getInfo(uid) {
    if (uid) {
      const info = await rclient.hgetAsync(ASSETS_INFO_KEY, uid);
      return info && JSON.parse(info);
    } else {
      const info = await rclient.hgetallAsync(ASSETS_INFO_KEY) || {};
      for (const k of Object.keys(info))
        info[k] = JSON.parse(info[k]);
      return info;
    }
  }

  async setAssetsConfig(config) {
    let errMsg = null;
    const result = await FireRouter.setAssetsConfig(config).catch((err) => {
      errMsg = err.message;
    });
    if (errMsg)
      throw new Error(errMsg);
    if (result.code != 200) {
      errMsg = result.body && !_.isEmpty(result.body.errors) ? result.body.errors[0] : "Failed to get assets config";
      throw new Error(errMsg);
    }
  }

  async setInfo(info) {
    const obj = JSON.parse(JSON.stringify(info));
    for (const k of Object.keys(obj))
      obj[k] = JSON.stringify(obj[k]);
    await rclient.hmsetAsync(ASSETS_INFO_KEY, obj);
  }

  async deleteConfig(uid) {
    let errMsg = null;
    const result = await FireRouter.deleteAssetsConfig(uid).catch((err) => {
      errMsg = err.message;
    });
    if (errMsg)
      throw new Error(errMsg);
    if (result.code != 200) {
      errMsg = result.body && !_.isEmpty(result.body.errors) ? result.body.errors[0] : "Failed to get assets config";
      throw new Error(errMsg);
    }
  }

  async deleteInfo(uid) {
    await rclient.hdelAsync(ASSETS_INFO_KEY, uid);
  }
}

module.exports = AssetsManagerPlugin;