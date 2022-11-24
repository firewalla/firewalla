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

const { exec } = require('child-process-promise')
const { delay } = require('../util/util.js')

let firewalla = require('../net2/Firewalla.js');

let instance = null;

class SysTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  stopServices() {
    return exec(`${firewalla.getFirewallaHome()}/scripts/fire-stop`);
  }

  // call main-run
  async restartServices(time = 0) {
    log.warn(`All services restart in ${time} seconds`)
    await delay(time * 1000)
    return exec(`NO_MGIT_RECOVER=1 NO_FIREKICK_RESTART=1 ${firewalla.getFirewallaHome()}/scripts/main-run`)
  }

  async rebootSystem(time = 0) {
    log.warn(`======= System Reboot in ${time} seconds =======`)
    await delay(time * 1000)
    return exec("sync & /home/pi/firewalla/scripts/fire-reboot-normal")
  }

  shutdownServices() {
    return exec("sleep 3; /home/pi/firewalla/scripts/fire-shutdown-normal")
  }

  cancelShutdown() {
    return exec("sudo shutdown -c")
  }

  restartFireKickService() {
    return exec("redis-cli del firekick:pairing:message; sudo systemctl restart firekick")
  }

  stopFireKickService() {
    return exec("sudo systemctl stop firekick")
  }

  async isFireKickRunning() {
    try {
      await exec("systemctl is-active --quiet firekick");
      return true;
    } catch(err) {
      return false;
    }
  }

  upgradeToLatest() {
    return exec("NO_FIREKICK_RESTART=1 /home/pi/firewalla/scripts/fireupgrade.sh soft")
  }

  resetPolicy() {
    return exec("/home/pi/firewalla/scripts/reset-policy")
  }

  async cleanIntel() {
    await exec("redis-cli keys 'intel:ip:*' | xargs -n 100 redis-cli del").catch(() => undefined);
//    await exec("redis-cli keys 'rdns:ip:*' | xargs -n 100 redis-cli del").catch(() => undefined);
//    await exec("redis-cli keys 'rdns:domain:*' | xargs -n 100 redis-cli del").catch(() => undefined);
    await exec("redis-cli del intel:security:tracking").catch(() => undefined);
    await exec("redis-cli keys 'dynamicCategoryDomain:*' | xargs redis-cli del").catch(() => undefined);
    await exec("redis-cli keys 'inteldns:*' | xargs -n 100 redis-cli del").catch(() => undefined);
    await exec("sudo pkill -SIGHUP dnsmasq").catch(() => undefined);
  }
}

module.exports = SysTool
