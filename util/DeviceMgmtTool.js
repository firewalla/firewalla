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
  
  resetDevice() {
    log.info("Resetting device to factory defaults...");

    if(Firewalla.isOverlayFS()) {
      log.info("OverlayFS is enabled");
      return new Promise((resolve, reject) => {
        let cmd = Firewalla.getFirewallaHome() + "/scripts/system-reset-all-overlayfs.sh";

        cp.exec(cmd, (err) => {
          if(err) {
            log.error("Failed to rename overlay upper work directory to backup:", err, {});
          }
          log.info("Resetting with cmd ",cmd);
          resolve();
        });
      });      
    } else {
      log.info("Regular filesystem without OverlayFS");
      let script = Firewalla.getFirewallaHome() + "/scripts/system-reset-all";
      return new Promise((resolve, reject) => {
        cp.exec(script, (err, stdout, stderr) => {
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
