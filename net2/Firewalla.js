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
const log = require("../net2/logger.js")(__filename)
let config;

let cp = require('child_process');

let util = require('util');

// TODO: Read this from config file
let firewallaHome = process.env.FIREWALLA_HOME || "/home/pi/firewalla"
let _isProduction = null;
let _isDocker = null;
let _platform = null;
let _isOverlayFS = null;
let _branch = null
let _lastCommitDate = null

let version = null;

const Promise = require('bluebird');

const async = require('asyncawait/async')
const await = require('asyncawait/await')

const rclient = require('../util/redis_manager.js').getRedisClient()

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

function getBranch() {
  if(_branch == null) {
    _branch = require('child_process').execSync("git rev-parse --abbrev-ref HEAD", {encoding: 'utf8'}).replace("\n", "")
  }
  return _branch
}

function getLastCommitDate() {
  if(_lastCommitDate == null) {
    _lastCommitDate = Number(require('child_process').execSync("git show -s --format=%ct HEAD", {encoding: 'utf8'}).replace("\n", ""))
  }
  return _lastCommitDate
}

function getProdBranch() {
  return async(() => {
    let branch = await (rclient.hgetAsync("sys:config", "prod.branch"))
    if(branch) {
      return branch
    } else {
      return "release_6_0" // default
    }
  })()
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

function getOverlayUpperDirPartition() {
  return "/media/root-rw/"
}


function isDevelopmentVersion() {
  let branch = getBranch()
  if(branch === "master" || branch.includes("master")) {
    return true
  } else {
    return false
  }
}

function isBeta() {
  let branch = getBranch()
  if(branch.match(/^beta_.*/)) {
    return true
  } else {
    return false
  }  
}

function isProduction() {
  let branch = getBranch()
  if(branch.match(/^release_.*/)) {
    return true
  } else {
    return false
  }
  
  // if either of condition matches, this is production environment
  if (_isProduction === null) {
    _isProduction =  process.env.FWPRODUCTION != null || require('fs').existsSync("/tmp/FWPRODUCTION");
  }
  return _isProduction;
}

function isProductionOrBeta() {
  return isProduction() || isBeta()
}

function getReleaseType() {
  if(isProduction()) {
    return "prod"
  } else if(isBeta()) {
    return "beta"
  } else if (isDevelopmentVersion()) {
    return "dev"
  } else {
    return "unknown"
  }
}

function isDocker() {
  if(_isDocker === null) {
    _isDocker = require('fs').existsSync("/.dockerenv");
  }

  return _isDocker;
}

function isTravis() {
  if(process.env.TRAVIS)
    return true;
  return false;
}

function isOverlayFS() {
  if(_isOverlayFS === null) {
    let result = true;
    try {
      cp.execSync("grep 'overlayroot / ' /proc/mounts &>/dev/null");
    } catch(err) {
      result = false;
    }

    _isOverlayFS = result;
  }

  return _isOverlayFS;
}

function isBootingComplete() {
  return async(() => {
    let exists = await (rclient.existsAsync("bootingComplete"))
    return exists == 1
  })()
}

function setBootingComplete() {
  return rclient.setAsync("bootingComplete", "1")
}

function resetBootingComplete() {
  return rclient.delAsync("bootingComplete")
}

function isFirstBindDone() {
  return async(() => {
    let exists = await (rclient.existsAsync("firstBinding"))
    return exists == 1
  })()
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
  rclient.get("sys:bone:info", (err, data) => {
    if (data) {
      _boneInfo = JSON.parse(data);
      if (callback) {
        callback(null, JSON.parse(data));
      }
    } else {
      if (callback) {
        callback(null, null);
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
    let versionElements = [];

    try {
      versionElements = require('child_process').execSync(cmd).toString('utf-8')
        .replace(/\n$/, '').split("-");
    } catch (err) {
      log.error("Failed to get git version tags", err, {});
    }

    if(versionElements.length === 3) {
      version = util.format("%s.%s (%s)", versionElements[0], versionElements[1], versionElements[2]);
    } else if(versionElements.length === 1) {
      version = util.format("%s.0 (0)", versionElements[0])
    } else {
      version = "0.0 (0)";
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

const BLACK_HOLE_IP = "198.51.100.99";
const BLUE_HOLE_IP = "198.51.100.100";
const RED_HOLE_IP = "198.51.100.101";

function isReservedBlockingIP(ip) {
  return [BLACK_HOLE_IP, BLUE_HOLE_IP, RED_HOLE_IP, "0.0.0.0"].includes(ip);
}

function isMain() {
  return process.title === "FireMain";
}

function isMonitor() {
  return process.title === "FireMon";
}

function getProcessName() {
  return process.title;
}

module.exports = {
  getFirewallaHome: getFirewallaHome,
  getLocalesDirectory: getLocalesDirectory,
  getUserHome: getUserHome,
  getHiddenFolder: getHiddenFolder,
  getLogFolder: getLogFolder,
  getRuntimeInfoFolder: getRuntimeInfoFolder,
  getUserConfigFolder: getUserConfigFolder,
  getUserID: getUserID,
  getBoneInfo: getBoneInfo,
  getBoneInfoSync: getBoneInfoSync,
  constants: constants,
  getVersion: getVersion,
  getBranch:getBranch,
  isDocker:isDocker,
  getTempFolder: getTempFolder,
  getPlatform: getPlatform,
  isTravis: isTravis,
  isOverlayFS: isOverlayFS,
  getOverlayUpperDirPartition:getOverlayUpperDirPartition,
  getEncipherConfigFolder: getEncipherConfigFolder,
  isBootingComplete:isBootingComplete,
  setBootingComplete:setBootingComplete,
  resetBootingComplete:resetBootingComplete,
  isFirstBindDone: isFirstBindDone,

  isProduction: isProduction,
  isBeta:isBeta,
  isDevelopmentVersion:isDevelopmentVersion,
  isProductionOrBeta:isProductionOrBeta,

  getProdBranch: getProdBranch,
  getReleaseType: getReleaseType,
  isReservedBlockingIP: isReservedBlockingIP,

  isMain:isMain,
  isMonitor:isMonitor,
  getLastCommitDate:getLastCommitDate,

  getProcessName:getProcessName
}
