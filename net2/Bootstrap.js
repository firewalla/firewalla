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

// bootstrap.js will setup all necessary configuration, database and etc. so that FireMain, FireApi, FireMon
// are ready to use after setup

let Promise = require('bluebird');

let cw = require("../net2/FWCloudWrapper");

let SysManager = require('../net2/SysManager.js');
let sysManager = new SysManager();
let firewallaConfig = require('../net2/config.js').getConfig();

let bone = require('../lib/Bone');

function bootstrap() {
  return cw.login()
    .then(() => {
      return bone.waitUtilCloudReady(() => {
        return sysManager.setConfig(firewallaConfig)
          .then(() => {
            return new Promise((resolve, reject) => {
              sysManager.update(() => {
                resolve();
              })
            })
          });
      })
    });  
}

module.exports = {
  bootstrap: bootstrap
}