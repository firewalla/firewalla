/*    Copyright 2016-2021 Firewalla Inc.
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

// bootstrap.js will setup all necessary configuration, database and etc. so that FireMain, FireApi, FireMon
// are ready to use after setup

let Promise = require('bluebird');

let log = require("../net2/logger.js")(__filename);

let cw = require("../net2/FWCloudWrapper");

let sysManager = require('../net2/SysManager.js');

let firewallaConfig = require('../net2/config.js').getConfig();

let Discovery = require("./Discovery.js");
let d = new Discovery("bootstrap", firewallaConfig, "info", false);

let bone = require('../lib/Bone');

let license = require('../util/license.js');


let bootstrapped = false;

/*
 * this is basicly for tests, it does
  1. cloud login
  2. load config
  3. discover local network interfaces
  4. load network interface
 */
function bootstrap() {
  if(bootstrapped)
    return Promise.resolve();

  return (async() =>{
    await cw.getCloud().loadKeys()
    await cw.login()
    await bone.waitUntilCloudReadyAsync()
    let sysInfo = await sysManager.getSysInfoAsync()
    log.debug("License:", license.getLicense());
    await bone.checkinAsync(firewallaConfig.version, license.getLicense(), sysInfo);
  })()

    .then(() => {
      return new Promise((resolve, reject) => {
        d.discoverInterfaces(() => {
          sysManager.update(() => {
            bootstrapped = true;
            resolve();
          });
        });
      })
    })

}

function getGroup() {

}

function login() {

}

function groupReady() {

}

module.exports = {
  bootstrap: bootstrap
}
