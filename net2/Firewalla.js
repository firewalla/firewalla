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
var log;
var config;
var redis = require("redis");
var rclient = redis.createClient();
log = require("../net2/logger.js")("Firewalla", "info");

let util = require('util');

// TODO: Read this from config file
let firewallaHome = process.env.FIREWALLA_HOME || "/home/pi/firewalla"
let _isProduction = null;
let _isDocker = null;
let _platform = null; 

let version = null;

function getFirewallaHome() {
  return firewallaHome;
}

function getLocalesDirectory() {
  return firewallaHome + "/locales";
}

function getPlatform() {
  if(_platform === null) {
    _platform = require('child_process').execSync("uname -m", {encoding: 'utf8'}).replace("\n", "");
  }
  
  return _platform;
}

function getUserID() {
  return process.env.USER;
}

function getUserHome() {
  return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

function getLogFolder() {
  return getUserHome() + "/.forever";
}

function getHiddenFolder() {
  return getUserHome() + "/.firewalla";
}

function isProduction() {
  // if either of condition matches, this is production environment
  if (_isProduction==null) {
    _isProduction =  process.env.FWPRODUCTION != null || require('fs').existsSync("/tmp/FWPRODUCTION");
  }
  return _isProduction;
}

function isDocker() {
  if(_isDocker == null) {
    _isDocker = require('fs').existsSync("/.dockerenv");
  }

  return _isDocker;
}

function isTravis() {
  if(process.env.TRAVIS)
    return true;
  return false;
}

function getRuntimeInfoFolder() {
  return getHiddenFolder() + "/run";
}

function getUserConfigFolder() {
  return getHiddenFolder() + "/config";
}

function getTempFolder() {
  return getHiddenFolder() + "/tmp";
}

function getEncipherConfigFolder() {
  return "/encipher.config";
}

// Get config data from fishbone
var _boneInfo = null;
function getBoneInfo(callback) {
    rclient.get("sys:bone:info",(err,data)=>{
        if (data) {
            _boneInfo = JSON.parse(data);
            if (callback) {
                callback(null, JSON.parse(data));
            }
        } else {
            if (callback) {
                callback(null,null);
            }
        }
    });
}

function getBoneInfoSync() {
    return _boneInfo;
}

function getVersion() {
  if(!version) {
    let cmd = "git describe --tags";
    let versionElements = require('child_process').execSync(cmd).toString('utf-8')
        .replace(/\n$/, '').split("-");

    if(versionElements.length === 3) {
      version = util.format("%s.%s (%s)", versionElements[0], versionElements[1], versionElements[2]);
    } else {
      version = "";
    }
  }

  return version;
}

var __constants = {
  "MAX_V6_PERHOST":6
};

function constants(name) {
    return __constants[name] 
}

module.exports = {
  getFirewallaHome: getFirewallaHome,
  getLocalesDirectory: getLocalesDirectory,
  getUserHome: getUserHome,
  getHiddenFolder: getHiddenFolder,
  isProduction: isProduction,
  getLogFolder: getLogFolder,
  getRuntimeInfoFolder: getRuntimeInfoFolder,
  getUserConfigFolder: getUserConfigFolder,
  getUserID: getUserID,
  getBoneInfo: getBoneInfo,
  getBoneInfoSync: getBoneInfoSync,
  constants: constants,
  getVersion: getVersion,
  isDocker:isDocker,
  getTempFolder: getTempFolder,
  getPlatform: getPlatform,
  isTravis: isTravis,
  getEncipherConfigFolder: getEncipherConfigFolder
}

