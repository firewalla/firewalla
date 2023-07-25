/*    Copyright 2019-2023 Firewalla Inc.
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
const rclient = require('../util/redis_manager.js').getRedisClient();
const Sensor = require('./Sensor.js').Sensor
const Promise = require('bluebird')
const extensionManager = require('./ExtensionManager.js')
const guardianListKey = "guardian:alias:list";
const Guardian = require('./Guardian');
const _ = require('lodash');

class GuardianSensor extends Sensor {
  constructor(config) {
    super(config);
    this.guardianMap = {};
  }

  async apiRun() {
    await this.startGuardians();

    extensionManager.onGet("guardianSocketioServer", (msg, data) => {
      return this.getServer(data);
    });

    extensionManager.onSet("guardianSocketioServer", async (msg, data) => {
      return this.setServer(data);
    });

    extensionManager.onGet("guardian.business", async (msg, data) => {
      return this.getBusiness(data);
    });

    extensionManager.onSet("guardian.business", async (msg, data) => {
      return this.setBusiness(data);
    });

    extensionManager.onGet("guardianSocketioRegion", (msg, data) => {
      return this.getRegion(data);
    });

    extensionManager.onCmd("startGuardianSocketioServer", (msg, data) => {
      return this.start(data);
    });

    extensionManager.onCmd("stopGuardianSocketioServer", (msg, data) => {
      return this.stop(data);
    });

    extensionManager.onCmd("resetGuardian", (msg, data) => {
      return this.reset(data);
    });

    extensionManager.onCmd("setAndStartGuardianService", async (msg, data) => {
      return this.setAndStartGuardianService(data);
    });

    extensionManager.onGet("guardians", async (msg, data) => {
      return this.getGuardians(data);
    });

    extensionManager.onGet("guardian", async (msg, data) => {
      return this.getGuardian(data);
    })
  }

  async startGuardians() {
    let aliases = await rclient.zrangeAsync(guardianListKey, 0, -1);
    aliases = _.uniq((aliases || []).concat("default"));

    log.forceInfo('Start guardian for these alias', aliases);

    await Promise.all(aliases.map(async alias => {
      const guardian = new Guardian(alias, this.config);
      await guardian.init();
      this.guardianMap[alias] = guardian;
    }))
  }

  async getGuardianByAlias(alias = "default") {
    let guardian = this.guardianMap[alias];
    if (!guardian) {
      guardian = new Guardian(alias, this.config);
      this.guardianMap[alias] = guardian;
      await rclient.zaddAsync(guardianListKey, Date.now() / 1000, alias);
    }
    return guardian;
  }

  async getGuardianByMspId(mspId) {
    if (!mspId) return this.getGuardianByAlias("default") // if mspId undefined, get default guardian
    for (const key in this.guardianMap) {
      const guardian = this.guardianMap[key];
      const id = await guardian.getMspId();
      if (id == mspId) {
        return guardian;
      }
    }
  }

  async getServer(data = {}) {
    const guardian = await this.getGuardianByAlias(data.alias);
    return guardian.getServer();
  }

  async setServer(data = {}) {
    const guardian = await this.getGuardianByAlias(data.alias);
    return guardian.setServer(data);
  }

  async getBusiness(data = {}) {
    const guardian = await this.getGuardianByAlias(data.alias);
    return guardian.getBusiness();
  }

  async setBusiness(data = {}) {
    const guardian = await this.getGuardianByAlias(data.alias);
    return guardian.setBusiness(data);
  }

  async getRegion(data = {}) {
    const guardian = await this.getGuardianByAlias(data.alias);
    return guardian.getRegion();
  }

  async start(data = {}) {
    const guardian = await this.getGuardianByAlias(data.alias);
    return guardian.start();
  }

  async stop(data = {}) {
    const guardian = await this.getGuardianByAlias(data.alias);
    return guardian.stop();
  }

  async reset(data = {}) {
    const guardian = await this.getGuardianByMspId(data.mspId);
    if (!guardian) {
      const err = new Error(`The guardian ${data.mspId} doesn't exist, please check`);
      err.code = 404;
      throw err;
    }
    await guardian.reset();
    await rclient.zremAsync(guardianListKey, guardian.name);
    delete this.guardianMap[guardian.name];
  }

  async setAndStartGuardianService(data) {
    const guardian = await this.getGuardianByAlias(data.alias);
    return guardian.setAndStartGuardianService(data);
  }

  async getGuardians() {
    const result = [];
    await Promise.all(Object.keys(this.guardianMap).map(async (alias) => {
      const guarndian = await this.getGuardianByAlias(alias);
      const info = await guarndian.getGuardianInfo();
      info && result.push(info);
    }))
    return result
  }

  async getGuardian(data) {
    const guardian = await this.getGuardianByAlias(data.alias);
    return guardian.getGuardianInfo();
  }
}

module.exports = GuardianSensor;
