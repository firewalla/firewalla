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

let instance = null;

const RedPlatform = require('./red/RedPlatform.js');
const BluePlatform = require('./blue/BluePlatform.js');
const DockerPlatform = require('./docker/DockerPlatform.js');

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

  getPlatform() {
    if (this.platform) {
      return this.platform;
    }

    const uname = this.getPlatformName();
    
    switch (uname) {
    case "aarch64":
      this.platform = new BluePlatform();
      break;
    case "armv7l":
      this.platform = new RedPlatform();
      break;      
    case "x86_64":
      this.platform = new DockerPlatform();
    default:
      return null;
      break;
    }

    return this.platform;
  }
}

module.exports = new PlatformLoader();