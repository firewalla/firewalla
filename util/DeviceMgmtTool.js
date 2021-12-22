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
const fs = require("fs");
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

  async bluetoothReset() {
    log.info("Resetting box via firereset...")
    try {
      await cpp.exec("sudo pkill -x -SIGUSR1 firereset");
      await cpp.exec("sudo pkill -x -SIGUSR1 firereset");
      await cpp.exec("sudo pkill -x -SIGUSR1 firereset");
    } catch(err) {
      log.error("Got error when resetting box via firereset, err:", err);
    }
  }

  async bluetoothResetAndShutdown() {
    log.info("Resetting box and Shutdown via firereset...")
    try {
      await cpp.exec("sudo pkill -x -SIGUSR2 firereset");
      await cpp.exec("sudo pkill -x -SIGUSR2 firereset");
      await cpp.exec("sudo pkill -x -SIGUSR2 firereset");
    } catch(err) {
      log.error("Got error when resetting box and shutdown via firereset, err:", err);
    }
  }

  switchCleanSupportFlag(op=true) {
    const onOff = op ? "ON" : "OFF";
    log.info(`Switch ${onOff} clean support flag`);
    const CLEAN_SUPPORT_FLAG_FILE = '/dev/shm/clean_support.touch'
    try {
      if ( op ) {
        fs.closeSync(fs.openSync(CLEAN_SUPPORT_FLAG_FILE,'w'));
      } else {
        fs.unlinkSync(CLEAN_SUPPORT_FLAG_FILE);
      }
    } catch (err) {
      log.error(`failed to switch ${onOff} clean support flag(${CLEAN_SUPPORT_FLAG_FILE}):`,err);
    }
  }

  resetDevice(config) {
    log.info("Resetting device to factory defaults...");

    this.switchCleanSupportFlag(config && config.clean_support);

    if(platform.isFireRouterManaged()) {
      if(config && config.shutdown) {
        return this.bluetoothResetAndShutdown();
      } else {
        return this.bluetoothReset();
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
