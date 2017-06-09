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

var eptname = config.endpoint_name;
var appId = config.appId;
var appSecret = config.appSecret;
var cloud = require('../../encipher');

var eptcloud = new cloud(eptname);
var nbControllers = {};

var instance = null;

module.exports = class {
  constructor(loglevel) {
    if (instance == null) {
      instance = this;

      // Initialize cloud and netbot controller
      eptcloud.eptlogin(appId, appSecret, null, eptname, function(err, result) {
        if(err) {
          log.info("Failed to login encipher cloud: " + err);
          process.exit(1);
        } else {
          log.info("Success logged in Firewalla Cloud");
          eptcloud.eptFind(result, function (err, ept) {
            if(err) {
              log.error("Failed to find device identity: %s", err.toString());
            } else {
              log.info("Got device identity");
            }
            
            eptcloud.eptGroupList(eptcloud.eid, function (err, groups) {
              if(err) {
                log.error("Fail to find groups")
              } else {
                log.info("Found %d groups this device belongs to", groups.length);
              }
              groups.forEach(function(group) {
                let groupID = group.gid;
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
            });
          }); 
        }
      });
    }
    return instance;
  }

  getNetBotController(groupID) {
    return nbControllers[groupID];
  }

  getCloud() {
    return eptcloud;
  }
}
