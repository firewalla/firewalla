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

const { delay } = require('./util.js');

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
    log.info("Resetting box via firereset...");
    try {
      await cpp.exec("sudo pkill -x -SIGUSR1 firereset");
      await cpp.exec("sudo pkill -x -SIGUSR1 firereset");
      await cpp.exec("sudo pkill -x -SIGUSR1 firereset");
      return true;
    } catch(err) {
      log.error("Got error when resetting box via firereset, err:", err);
      return false;
    }
  }

  async bluetoothResetAndShutdown() {
    log.info("Resetting box and Shutdown via firereset...")
    try {
      await cpp.exec("sudo pkill -x -SIGUSR2 firereset");
      await cpp.exec("sudo pkill -x -SIGUSR2 firereset");
      await cpp.exec("sudo pkill -x -SIGUSR2 firereset");
      return true;
    } catch(err) {
      log.error("Got error when resetting box and shutdown via firereset, err:", err);
      return false;
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

  async resetDevice(config) {
    log.info("Resetting device to factory defaults...");

    this.switchCleanSupportFlag(config && !config.keepLog);

    if(platform.isFireRouterManaged()) {
      if(config && config.shutdown) {
        return this.bluetoothResetAndShutdown();
      } else {
        return this.bluetoothReset();
      }
    }

    if(Firewalla.isOverlayFS()) {
      log.info("OverlayFS is enabled");
      let cmd = ((config && config.shutdown) ? "FIREWALLA_POST_RESET_OP=shutdown " : "") + Firewalla.getFirewallaHome() + "/scripts/"+platform.getSystemResetAllOverlayfsScriptName();
      log.info("Resetting with cmd ",cmd);
      try {

        // don't await so that fireapi can return response to app before it's killed
        (async () => {
          // wait for a while before killing everything
          await delay(3 * 1000);
          await cpp.exec(cmd);
        })();

        return true;
      } catch(err) {
        log.error("Failed to rename overlay upper work directory to backup:", err);
        return false;
      }
    } else {
      log.info("Regular filesystem without OverlayFS");
      let cmd = ((config && config.shutdown) ? "FIREWALLA_POST_RESET_OP=shutdown " : "") + Firewalla.getFirewallaHome() + "/scripts/system-reset-all";
      log.info("Resetting with cmd ",cmd);
      try {
        await cpp.exec(cmd);
        return true;
      } catch(err) {
        log.error("Failed to reset, err:", err);
        return false;
      }
    }
  }
}

module.exports = new DeviceMgmtTool();
