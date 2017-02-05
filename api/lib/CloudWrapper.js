/*    Copyright 2016 Rottiesoft LLC 
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

let Firewalla = require('../../net2/Firewalla.js');
let f = new Firewalla("config.json", 'info');
let fHome = f.getFirewallaHome();

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
var log = null;

module.exports = class {
    constructor(loglevel) {
        if (instance == null) {
            log = require("../../net2/logger.js")("encryption", loglevel);
            instance = this;

            // Initialize cloud and netbot controller
            eptcloud.eptlogin(appId, appSecret, null, eptname, function(err, result) {
              if(err) {
                  console.log("Failed to login encipher cloud: " + err);
                  process.exit(1);
              } else {
                 eptcloud.eptFind(result, function (err, ept) {
                      console.log("Success logged in", result, ept);
                      eptcloud.eptGroupList(eptcloud.eid, function (err, groups) {
                          console.log("Groups found ", err, groups);
                          groups.forEach(function(group) {
                              let groupID = group.gid;
                              let NetBotController = require("../../controllers/netbot.js");
                              let nbConfig = jsonfile.readFileSync(fHome + "/controllers/netbot.json", 'utf8');
                              nbConfig.controller = config.controllers[0];
                              // temp use apiMode = false to enable api to act as ui as well
                              let nbController = new NetBotController(nbConfig, config, eptcloud, groups, groupID, true, false);
                              if(nbController) {
                                  nbControllers[groupID] = nbController;
                                  console.log("netbot controller for group " + groupID + " is intialized successfully");
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
