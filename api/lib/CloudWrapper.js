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

var Config = require('../../lib/Config.js');

let f = require('../../net2/Firewalla.js');
let fHome = f.getFirewallaHome();

let log = require('../../net2/logger.js')(__filename, 'info');

var jsonfile = require('jsonfile');

// FIXME, hard coded config file location
var configFileLocation = "/encipher.config/netbot.config";

var config = jsonfile.readFileSync(configFileLocation);
if (config == null) {
  console.log("Unable to read config file");
  process.exit(1);
}

let eptname = config.endpoint_name;
let appId = config.appId;
let appSecret = config.appSecret;
let cloud = require('../../encipher');

let eptcloud = null;
let nbControllers = {};

let instance = null;

let Bone = require('./../../lib/Bone');

let redis = require('redis');
let rclient = redis.createClient();
let Promise = require('bluebird');
Promise.promisifyAll(redis.RedisClient.prototype);

let async = require('asyncawait/async');
let await = require('asyncawait/await');

module.exports = class {
  constructor(loglevel) {
    if (instance == null) {
      instance = this;

      eptcloud = new cloud(eptname);
      
      async(() => {
        await(Bone.waitUntilCloudReadyAsync());
        this.init();
      })();
    }
    return instance;
  }
  
  isGroupLoaded(gid) {
    return nbControllers[gid];
  }
  
  init() {
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

            log.info("Found %d groups this device has joined", groups.length);

            if(groups.length === 0) {
              reject(new Error("This device belongs to no group"));
              return;
            }

            groups.forEach((group) => {
              let groupID = group.gid;
              if(nbControllers[groupID]) {
                return;
              }
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

  getNetBotController(groupID) {
    let controller = nbControllers[groupID];
    if(controller) {
      return Promise.resolve(controller);
    }

    return this.init()
      .then(() => {
        controller = nbControllers[groupID];
        if(controller) {
          return Promise.resolve(controller);
        } else {
          return Promise.reject(new Error("Failed to found group" + groupID));
        }
      });
  }

  getCloud() {
    return eptcloud;
  }
};
