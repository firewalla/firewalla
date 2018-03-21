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

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()

const Promise = require('bluebird');

const async = require('asyncawait/async');
const await = require('asyncawait/await');

const exec = require('child-process-promise').exec

let firewalla = require('../net2/Firewalla.js');

let instance = null;

class SysTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  // call main-run
  restartServices() {
    return exec(`NO_MGIT_RECOVER=1 NO_FIREKICK_RESTART=1 ${firewalla.getFirewallaHome()}/scripts/main-run`)
  }

  rebootServices() {
    return exec("sync & /home/pi/firewalla/scripts/fire-reboot-normal")
  }

  shutdownServices() {
    return exec("sleep 3; sudo shutdown -h now")
  }

  restartFireKickService() {
    return exec("sudo systemctl restart firekick")
  }

  stopFireKickService() {
    return exec("sudo systemctl stop firekick")
  }

  upgradeToLatest() {
    return exec("NO_FIREKICK_RESTART=1 /home/pi/firewalla/scripts/fireupgrade.sh soft")
  }

  resetPolicy() {
    return exec("/home/pi/firewalla/scripts/reset-policy")
  }
}

module.exports = SysTool
