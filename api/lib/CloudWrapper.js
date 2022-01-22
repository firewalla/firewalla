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

const f = require('../../net2/Firewalla.js');
const fHome = f.getFirewallaHome();

const log = require('../../net2/logger.js')(__filename);

// FIXME, hard coded config file location
const configFileLocation = "/encipher.config/netbot.config";
const Constants = require('../../net2/Constants.js');

const cloud = require('../../encipher');
const Bone = require('./../../lib/Bone');
const rclient = require('../../util/redis_manager.js').getRedisClient()
const { delay } = require('../../util/util.js')

const util = require('util')
const jsonfile = require('jsonfile');
const jsReadFile = util.promisify(jsonfile.readFile)


const nbControllers = {};
let instance = null;

module.exports = class {
  constructor() {

    if (instance == null) {
      instance = this;
      this.controllerCreated = false;

      (async() => {
        log.info("[Boot] Loading config");
        this.config = await jsReadFile(configFileLocation);
        if (this.config == null) {
          console.log("Unable to read config file", configFileLocation);
          process.exit(1);
        }

        this.eptcloud = new cloud(this.config.endpoint_name);

        log.info("[Boot] Waiting for security keys to be ready");
        // Must wait here for FireKick to generate keys
        await this.eptcloud.untilKeyReady();

        log.info("[Boot] Loading security keys");
        await this.eptcloud.loadKeys();

        log.info("[Boot] Waiting for cloud token to be ready");
        // token ready
        await Bone.waitUntilCloudReadyAsync();

        log.info("[Boot] Setting up communication channel with cloud");
        this.tryingInit();

        // setup API sensors
        this.sl = require('../../sensor/APISensorLoader.js');
        await this.sl.initSensors(this.eptcloud);
        this.sl.run();
      })().catch(err => {
        log.error("Failed to init", err)
      });


    }
    return instance;
  }

  async tryingInit() {
    try {
      await this.init();
    } catch (err) {
      log.error('Init failed, retry now...', err.message)
      log.debug(err.stack)

      try {
        // create nbController in offline mode when connection to cloud failed
        const { gid } = await Bone.checkCloud()
        if (!nbControllers[gid]) {
          const name = await f.getBoxName();
          await this.createController(gid, name, [], true)
          this.controllerCreated = true
        }
      } catch(err) {
        log.error('Error creating controller', err)
      }

      await delay(3000);
      return this.tryingInit();
    }
  }

  isGroupLoaded(gid) {
    return nbControllers[gid];
  }

  async init() {
    log.info("Initializing Cloud Wrapper...");

    await this.eptcloud.eptLogin(this.config.appId, this.config.appSecret, null, this.config.endpoint_name)

    log.info("Success logged in Firewalla Cloud");

    const groups = await this.eptcloud.eptGroupList()

    log.info(`Found ${groups.length} groups this device has joined`);

    if(!groups.length) {
      log.error("Wating for kickstart process to create group");
      throw new Error("This device belongs to no group")
    }

    for (const group of groups) {
      await this.createController(group.gid, group.name, groups, false)
    }
    this.controllerCreated = true
  }

  async createController(gid, name, groups, offlineMode) {
    log.info(`Creating controller, gid: ${gid}, offlineMode: ${offlineMode}`)
    if (nbControllers[gid]) {
      if (nbControllers[gid].apiMode == offlineMode) {
        return;
      } else if (!offlineMode) {
        // controller already exist, reconnect to cloud
        nbControllers[gid].groups = groups
        nbControllers[gid].initEptCloud()
        return;
      }
    }
    await rclient.setAsync(Constants.REDIS_KEY_GROUP_NAME, name);
    let NetBotController = require("../../controllers/netbot.js");
    let nbConfig = await jsReadFile(fHome + "/controllers/netbot.json", 'utf8');
    nbConfig.controller = this.config.controllers[0];
    // temp use apiMode = false to enable api to act as ui as well
    let nbController = new NetBotController(nbConfig, this.config, this.eptcloud, groups, gid, true, offlineMode);
    if(nbController) {
      nbControllers[gid] = nbController;
      log.info("netbot controller for group " + gid + " is intialized successfully");
    }
  }

  async waitForController() {
    if (this.controllerCreated) return

    await delay(1000)
    return this.waitForController()
  }

  async getNetBotController(groupID) {
    let controller = nbControllers[groupID];
    if(controller) {
      return controller;
    }

    await this.waitForController()
    controller = nbControllers[groupID];
    if(controller) {
      return controller;
    } else {
      throw new Error("Failed to found group" + groupID);
    }
  }

  getCloud() {
    return this.eptcloud;
  }
};
