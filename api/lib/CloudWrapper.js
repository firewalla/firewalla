/*    Copyright 2016 - 2019 Firewalla INC
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

const log = require('../../net2/logger.js')(__filename, 'info');

const jsonfile = require('jsonfile');

// FIXME, hard coded config file location
const configFileLocation = "/encipher.config/netbot.config";

const config = jsonfile.readFileSync(configFileLocation);
if (config == null) {
  console.log("Unable to read config file", configFileLocation);
  process.exit(1);
}

const eptname = config.endpoint_name;
const appId = config.appId;
const appSecret = config.appSecret;
const cloud = require('../../encipher');

let eptcloud = null;
let nbControllers = {};

let instance = null;

const Bone = require('./../../lib/Bone');

const rclient = require('../../util/redis_manager.js').getRedisClient()

const { delay } = require('../../util/util.js')

const util = require('util')

module.exports = class {
  constructor() {
    
    if (instance == null) {
      instance = this;

      eptcloud = new cloud(eptname);
      this.eptcloud = eptcloud;

      (async() => {

        log.info("[Boot] Waiting for security keys to be ready");
        // key ready
        await eptcloud.utilKeyReady();

        log.info("[Boot] Loading security keys");
        await eptcloud.loadKeys();

        log.info("[Boot] Waiting for cloud token to be ready");
        // token ready
        await Bone.waitUntilCloudReadyAsync();

        log.info("[Boot] Setting up communication channel with cloud");
        this.tryingInit();

        // setup API sensors
        this.sl = require('../../sensor/APISensorLoader.js');
        this.sl.initSensors(eptcloud);
        this.sl.run();
      })();


    }
    return instance;
  }

  async tryingInit() {
    await util.promisify(setImmediate)()  // Magical hack preventing init() being called twice
    try {
      await this.init();
    } catch (err) {
      log.error('Init failed, retry now...', err)
      await delay(3000);
      return this.tryingInit();
    }
  }

  isGroupLoaded(gid) {
    return nbControllers[gid];
  }

  init() {
    log.info("Initializing Cloud Wrapper...");

    return new Promise((resolve, reject) => {
      // Initialize cloud and netbot controller
      eptcloud.eptlogin(appId, appSecret, null, eptname, function(err, result) {
        if(err) {
          log.info("Failed to login encipher cloud: " + err);
          process.exit(1);
        } else {
          log.info("Success logged in Firewalla Cloud");

          eptcloud.eptGroupList(eptcloud.eid, function (err, groups) {
            if(err) {
              log.error("Fail to find groups")
              reject(err);
              return;
            }

            log.info(`Found ${groups.length} groups this device has joined`);

            if(groups.length === 0) {
              log.error("Wating for kickstart process to create group");
              reject(new Error("This device belongs to no group"));
              return;
            }

            groups.forEach((group) => {
              let groupID = group.gid;
              if(nbControllers[groupID]) {
                return;
              }
              rclient.setAsync("groupName", group.name);
              let NetBotController = require("../../controllers/netbot.js");
              let nbConfig = jsonfile.readFileSync(fHome + "/controllers/netbot.json", 'utf8');
              nbConfig.controller = config.controllers[0];
              // temp use apiMode = false to enable api to act as ui as well
              let nbController = new NetBotController(nbConfig, config, eptcloud, groups, groupID, true, false);
              if(nbController) {
                nbControllers[groupID] = nbController;
                log.info("netbot controller for group " + groupID + " is intialized successfully");
              }
            });

            resolve();
          });
        }
      });
    })
  }

  async getNetBotController(groupID) {
    let controller = nbControllers[groupID];
    if(controller) {
      return controller;
    }

    await this.init()
    controller = nbControllers[groupID];
    if(controller) {
      return controller;
    } else {
      throw new Error("Failed to found group" + groupID);
    }
  }

  getCloud() {
    return eptcloud;
  }
};
