/*    Copyright 2016 Rottiesoft LLC 
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
var log;
var config;

// TODO: Read this from config file
var firewallaHome = process.env.FIREWALLA_HOME || "/home/pi/firewalla"

module.exports = class {
    getFirewallaHome() {
        return firewallaHome;
    }

    getUserHome() {
      return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
    }

    getFirewallaConfigFolder() {
      return this.getUserHome() + "/.firewalla/";
    }

    isProduction() {
      return process.env.FWPRODUCTION;
    }
};
