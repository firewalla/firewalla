/*    Copyright 2016-2019 Firewalla Inc.
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

let instance = null;

const execSync = require('child_process').execSync;

class PlatformLoader {
  constructor() {
    if (instance === null) {
      instance = this;
    }
    return instance;
  }

  getPlatformName() {
    if (!this.platformName) {
      const uname = execSync("uname -m", {encoding: 'utf8'}).trim();
      this.platformName = uname;
    }

    return this.platformName;
  }

  getBoardName() {
    if (!this.boardName) {
      this.boardName = execSync("awk -F= '/BOARD=/ {print $2}' /etc/*-release",{encoding:'utf8'}).trim();
    }
    return this.boardName
  }

  getPlatform() {
    if (this.platform) {
      return this.platform;
    }

    const uname = this.getPlatformName();

    switch (uname) {
      case "aarch64": {
        const boardName = this.getBoardName();
        switch (boardName) {
          case "nanopi-r2s":
          case "NanoPi-NEO3-Black": {
            const NavyPlatform = require('./navy/NavyPlatform.js');
            this.platform = new NavyPlatform();
            break;
          }
          case "nanopineo2": {
            const BluePlatform = require('./blue/BluePlatform.js');
            this.platform = new BluePlatform();
            break;
          }
          default:
            return null;
        }
        break;
      }
      case "armv7l": {
        const RedPlatform = require('./red/RedPlatform.js');
        this.platform = new RedPlatform();
        break;
      }
      case "x86_64": {
        const GoldPlatform = require('./gold/GoldPlatform.js');
        this.platform = new GoldPlatform();
        break;
      }
      default:
        return null;
    }

    return this.platform;
  }
}

module.exports = new PlatformLoader();
