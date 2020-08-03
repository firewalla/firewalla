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
let log = require("../net2/logger.js")(__filename);

let Firewalla = require('../net2/Firewalla.js');

let Promise = require('bluebird');
let cp = require('child_process');

const cpp = require('child-process-promise');
const platform = require('../platform/PlatformLoader.js').getPlatform();

let instance = null;
class DeviceMgmtTool {
  constructor() {
    if (!instance) {
      instance = this;
    }
    return instance;
  }
  
  _getOverlayUpperDirectory() {
    return Firewalla.getOverlayUpperDirPartition() + "/overlay";
  }
  
  _getOverlayUpperWorkDirectory() {
    return Firewalla.getOverlayUpperDirPartition() + "/overlay-workdir";
  }

  async deleteGroup(eptcloud, gid) {
    log.info("Delete group " + gid);
    await eptcloud.deleteGroup(gid)
    log.info("Group " + gid + " is deleted.");
  }

  async resetGold() {
    log.info("Resetting Gold...")
    try {
      await cpp.exec("sudo pkill -SIGUSR1 firereset");
      await cpp.exec("sudo pkill -SIGUSR1 firereset");
      await cpp.exec("sudo pkill -SIGUSR1 firereset");
    } catch(err) {
      log.error("Got error when resetting gold, err:", err);
    }
  }

  async resetGoldAndShutdown() {
    log.info("Resetting Gold and Shutdown...")
    try {
      await cpp.exec("sudo pkill -SIGUSR2 firereset");
      await cpp.exec("sudo pkill -SIGUSR2 firereset");
      await cpp.exec("sudo pkill -SIGUSR2 firereset");
    } catch(err) {
      log.error("Got error when resetting gold and shutdown, err:", err);
    }
  }

  resetDevice(config) {
    log.info("Resetting device to factory defaults...");

    if(platform.getName() === 'gold') {
      if(config && config.shutdown) {
        return this.resetGoldAndShutdown();
      } else {
        return this.resetGold();
      }
    }

    if(Firewalla.isOverlayFS()) {
      log.info("OverlayFS is enabled");
      return new Promise((resolve, reject) => {
        let cmd = ((config && config.shutdown) ? "FIREWALLA_POST_RESET_OP=shutdown " : "") + Firewalla.getFirewallaHome() + "/scripts/"+platform.getSystemResetAllOverlayfsScriptName();
        log.info("cmd: ",cmd);
        cp.exec(cmd, (err) => {
          if(err) {
            log.error("Failed to rename overlay upper work directory to backup:", err);
          }
          log.info("Resetting with cmd ",cmd);
          resolve();
        });
      });      
    } else {
      log.info("Regular filesystem without OverlayFS");
      let cmd = ((config && config.shutdown) ? "FIREWALLA_POST_RESET_OP=shutdown " : "") + Firewalla.getFirewallaHome() + "/scripts/system-reset-all";
      return new Promise((resolve, reject) => {
        cp.exec(cmd, (err, stdout, stderr) => {
          if(err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  }
}

module.exports = new DeviceMgmtTool();
