/*    Copyright 2016-2020 Firewalla Inc.
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


const cloud = require('../encipher');


const rclient = require('../util/redis_manager.js').getRedisClient()


const storage = require('node-persist');

const Firewalla = require('../net2/Firewalla');
const configContent = require('fs').readFileSync(Firewalla.getFirewallaHome() + "/config/netbot.config");
const config = JSON.parse(configContent);

const dbPath = Firewalla.getUserHome() + "/.encipher/db";
storage.initSync({
  'dir': dbPath
});

const eptname = config.endpoint_name;
const eptcloud = new cloud(eptname, null);

function getCloud() {
  return eptcloud;
}

async function initializeGroup() {
  let groupId = storage.getItemSync('groupId');
  if (groupId != null) {
    log.info("Found stored group x", groupId);
    return groupId;
  }

  log.info("Creating new group ", config.service, config.endpoint_name);
  let meta = JSON.stringify({
    'type': config.serviceType,
    'member': config.memberType,
  });
  const result = await eptcloud.eptCreateGroup(config.service, meta, config.endpoint_name)
  log.info(result);
  if (result !== null) {
    storage.setItemSync('groupId', result);
  }
  return result
}

async function login() {
  await eptcloud.eptLogin(config.appId, config.appSecret, null, config.endpoint_name)

  const gid = await initializeGroup();
  if (!gid) {
    throw new Error("Unable to get group id:");
  }

  const data = await rclient.hmsetAsync("sys:ept", {
    eid: eptcloud.eid,
    token: eptcloud.token,
    gid: gid
  })
  log.info("Set SYS:EPT", data,eptcloud.eid, eptcloud.token, gid);

  return {
    eid: eptcloud.eid,
    token: eptcloud.token,
    gid: gid
  }
}

module.exports = {
  login: login,
  getCloud: getCloud
}
