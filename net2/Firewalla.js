/*    Copyright 2016-2023 Firewalla Inc.
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

const cp = require('child_process');
const { exec } = require('child-process-promise')

const util = require('util');
const _ = require('lodash')
const Constants = require('./Constants.js');

// TODO: Read this from config file
let firewallaHome = process.env.FIREWALLA_HOME || "/home/pi/firewalla"
let firerouterHome = process.env.FIREROUTER_HOME || "/home/pi/firerouter"
let _isDocker = null;
let _platform = null;
let _isOverlayFS = null;
let _branch = null
let _lastCommitDate = null

let version = null;
let longVersion = null;
let latestCommitHash = null;

const rclient = require('../util/redis_manager.js').getRedisClient()

function getFirewallaHome() {
  return firewallaHome;
}

function getLocalesDirectory() {
  return firewallaHome + "/locales";
}

function getPlatform() {
  if(_platform === null) {
    _platform = cp.execSync("uname -m", {encoding: 'utf8'}).replace("\n", "");
  }

  return _platform;
}

function getBranch() {
  if(_branch == null) {
    _branch = cp.execSync("git rev-parse --abbrev-ref HEAD", {encoding: 'utf8'}).replace(/\n/g, "")
  }
  return _branch
}

function getLastCommitDate() {
  if(_lastCommitDate == null) {
    _lastCommitDate = Number(cp.execSync("git show -s --format=%ct HEAD", {encoding: 'utf8'}).replace("\n", ""))
  }
  return _lastCommitDate
}

async function getProdBranch() {
  let branch = await rclient.hgetAsync("sys:config", "prod.branch")
  if(branch) {
    return branch
  } else {
    return "release_6_0" // default
  }
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
  const branch = getBranch();

  if(!branch) {
    return false;
  }

  if(branch.match(/^beta_.*/)) {
    if(isAlpha()) {
      return false;
    }

    return true;
  } else {
    return false
  }  
}

function isAlpha() {
  let branch = getBranch()
  if(!branch) {
    return false;
  }

  if(branch.match(/^beta_8_.*/)) {
    return true;
  } else if (branch.match(/^beta_9_.*/)) {
    return true;
  } else if(branch.match(/^beta_7_.*/)) {
    return true;
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
}

function isProductionOrBeta() {
  return isProduction() || isBeta()
}

function isProductionOrBetaOrAlpha() {
  return isProduction() || isBeta() || isAlpha()
}


function getReleaseType() {
  if(isProduction()) {
    return "prod"
  } else if(isAlpha()) {
    return "alpha";
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
      cp.execSync("egrep 'overlay(root)? / ' /proc/mounts &>/dev/null");
    } catch(err) {
      result = false;
    }

    _isOverlayFS = result;
  }

  return _isOverlayFS;
}

async function isBootingComplete() {
  let exists = await rclient.existsAsync("bootingComplete")
  return exists == 1
}

function setBootingComplete() {
  return rclient.setAsync("bootingComplete", "1")
}

function resetBootingComplete() {
  return rclient.delAsync("bootingComplete")
}

async function isFirstBindDone() {
  let exists = await rclient.existsAsync("firstBinding")
  return exists == 1
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

function getFireRouterHome() {
  return firerouterHome
}

function getFireRouterHiddenFolder() {
  return `${getUserHome()}/.router`;
}

function getFireRouterRuntimeInfoFolder() {
  return `${getFireRouterHiddenFolder()}/run`;
}

function getFireRouterConfigFolder() {
  return `${getFireRouterHiddenFolder()}/config`;
}

// Get config data from fishbone
var _boneInfo = null;
async function getBoneInfoAsync() {
  try {
    const data = await rclient.getAsync("sys:bone:info")
    if (data) {
      _boneInfo = JSON.parse(data);
      return _boneInfo
    } else
      return null
  } catch(err) {
    log.error('Error getting boneInfo', err)
    return null
  }
}

function getBoneInfo(callback = ()=>{}) {
  return util.callbackify(getBoneInfoAsync)(callback)
}

function getBoneInfoSync() {
  return _boneInfo;
}

// deprecated
function getVersion() {
  if(!version) {
    let cmd = "git describe --tags";
    let versionElements = [];

    try {
      versionElements = cp.execSync(cmd).toString('utf-8')
        .replace(/\n$/, '').split("-");
    } catch (err) {
      log.error("Failed to get git version tags", err);
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


// short version is from the config.json file
function getLongVersion(shortVersion) {
  if(longVersion) {
    return longVersion;
  }

  try {
    // v(short version).commit_count (commit hash)
    const commitCount = cp.execSync("git rev-list --all --count").toString('utf-8').trim();
    longVersion = `v${shortVersion}.${commitCount} (${getLatestCommitHash()})`;
  } catch(err) {
    log.error("Failed to get long version, err:", err);
    longVersion = "v1.973.0 (xxxxxxxx)"; // this is just a placeholder
  }

  return longVersion;
}

function getLatestCommitHash() {
  if(!latestCommitHash) {
    const cmd = "git rev-parse HEAD"

    try {
      latestCommitHash = cp.execSync(cmd).toString('utf-8')
        .replace(/\n$/, '').substring(0, 8);
    } catch (err) {
      log.error("Failed to get latest commit hash", err);
    }
  }

  return latestCommitHash;
}

async function getLocalCommitHash() {
  const cmd = await exec("git rev-parse @")
  return cmd.stdout.trim()
}

async function getRemoteCommitHash() {
  // @{u}: remote-tracking branch
  // https://www.git-scm.com/docs/gitrevisions
  await exec("timeout 20s git fetch origin")
  const cmd = await exec("git rev-parse @{u}")
  return cmd.stdout.trim()
}

var __constants = {
  "MAX_V6_PERHOST":6
};

function constants(name) {
  return __constants[name]
}

const BLACK_HOLE_IP = "0.0.0.0";
const BLUE_HOLE_IP = "198.51.100.100";
const RED_HOLE_IP = "198.51.100.101";

function isReservedBlockingIP(ip) {
  // TODO: we should throw error here
  if (!_.isString(ip)) return true

  return [BLACK_HOLE_IP, BLUE_HOLE_IP, RED_HOLE_IP, "0.0.0.0"].includes(ip)
    || ip.match(/^[0:]+(:ffff:(0*:)?)?(0\.0\.0\.0|[0:]+)$/i); // all zero v6 address
}

function getRedHoleIP() {
  return RED_HOLE_IP;
}

function isMain() {
  return process.title === "FireMain";
}

function isMonitor() {
  return process.title === "FireMon";
}

function isApi() {
  return process.title === "FireApi";
}

function getProcessName() {
  return process.title;
}

async function getBoxName() {
  return rclient.getAsync(Constants.REDIS_KEY_GROUP_NAME);
}

function getExtraAssetsDir() {
  return `${getUserConfigFolder()}/assets_extra`;
}

module.exports = {
  getFirewallaHome: getFirewallaHome,
  getLocalesDirectory: getLocalesDirectory,
  getUserHome: getUserHome,
  getHiddenFolder: getHiddenFolder,
  getLogFolder: getLogFolder,
  getRuntimeInfoFolder: getRuntimeInfoFolder,
  getUserConfigFolder: getUserConfigFolder,
  getFireRouterHome,
  getFireRouterRuntimeInfoFolder: getFireRouterRuntimeInfoFolder,
  getFireRouterConfigFolder: getFireRouterConfigFolder,
  getUserID: getUserID,
  getBoneInfoAsync,
  getBoneInfo: getBoneInfo,
  getBoneInfoSync: getBoneInfoSync,
  constants: constants,
  getVersion: getVersion,
  getLongVersion,
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
  isAlpha: isAlpha,
  isDevelopmentVersion:isDevelopmentVersion,
  isProductionOrBeta:isProductionOrBeta,
  isProductionOrBetaOrAlpha:isProductionOrBetaOrAlpha,

  getProdBranch: getProdBranch,
  getReleaseType: getReleaseType,
  isReservedBlockingIP: isReservedBlockingIP,

  isMain:isMain,
  isMonitor:isMonitor,
  isApi:isApi,
  getLastCommitDate:getLastCommitDate,

  getProcessName:getProcessName,

  getRedHoleIP:getRedHoleIP,

  getLatestCommitHash:getLatestCommitHash,
  getLocalCommitHash,
  getRemoteCommitHash,
  getBoxName: getBoxName,
  getExtraAssetsDir: getExtraAssetsDir
}
