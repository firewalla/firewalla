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
let log = require("./logger.js")(__filename);

let Promise = require('bluebird');

let cloud = require('../encipher');


const rclient = require('../util/redis_manager.js').getRedisClient()


let storage = require('node-persist');

let Firewalla = require('../net2/Firewalla');
let configContent = require('fs').readFileSync(Firewalla.getFirewallaHome() + "/config/netbot.config");
let config = JSON.parse(configContent);

let dbPath = Firewalla.getUserHome() + "/.encipher/db";
storage.initSync({
  'dir': dbPath
});

let eptname = config.endpoint_name;
let eptcloud = new cloud(eptname, null);
eptcloud.debug(false);

function getCloud() {
  return eptcloud;
}

function initializeGroup(callback) {
  let groupId = storage.getItemSync('groupId');
  if (groupId != null) {
    log.info("Found stored group x", groupId);
    callback(null, groupId);
    return;
  }

  log.info("Creating new group ", config.service, config.endpoint_name);
  let meta = JSON.stringify({
    'type': config.serviceType,
    'member': config.memberType,
  });
  eptcloud.eptcreateGroup(config.service, meta, config.endpoint_name, function (e, r) {
    log.info(r);
    if (e === null && r !== null) {
      storage.setItemSync('groupId', r);
    }
    callback(e, r);
  });
}

function login() {
  return new Promise((resolve, reject) => {
    
    eptcloud.eptlogin(config.appId, config.appSecret, null, config.endpoint_name, function (err, result) {
      if (err == null) {
        initializeGroup(function (err, gid) {
          if (gid) {
            rclient.hmsetAsync("sys:ept", {
              eid: eptcloud.eid,
              token: eptcloud.token,
              gid: gid
            }).then((data) => {
              log.info("Set SYS:EPT", err, data,eptcloud.eid, eptcloud.token, gid);
              resolve({
                eid: eptcloud.eid,
                token: eptcloud.token,
                gid: gid
              });
            });
          } else {
            log.error("Unable to get group id:", err, {})
            reject(err);
          }
        });
      } else {
        log.error("Unable to login", err);
        reject(err);
      }
    });
  })
}

module.exports = {
  login: login,
  getCloud: getCloud
}