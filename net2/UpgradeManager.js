/*    Copyright 2019-2024 Firewalla Inc.
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
const fs = require("fs");

const log = require('./logger.js')(__filename);

const f = require('./Firewalla.js')
const config = require('./config.js')
const platform = require('../platform/PlatformLoader.js').getPlatform();

const { fileExist, fileTouch, fileRemove } = require('../util/util.js');

const _ = require('lodash')
const { exec } = require('child-process-promise')

const NOAUTO_FLAG_PATH_FW = f.getUserConfigFolder() + '/.no_auto_upgrade'
const NOAUTO_FLAG_PATH_FR = f.getFireRouterConfigFolder() + '/.no_auto_upgrade'
const NOCHECK_FLAG_PATH_FW = f.getUserConfigFolder() + '/.no_upgrade_check'
const NOCHECK_FLAG_PATH_FR = f.getFireRouterConfigFolder() + '/.no_upgrade_check'

/*
 * If the system is upgrading ...
 */
function isUpgrading() {
  return fs.existsSync("/tmp/FWUPGRADING");
}

/*
 * Mark the system finished rebooting after reboot
 */
function finishUpgrade() {
  if (fs.existsSync("/tmp/FWUPGRADING")) {
    fs.unlinkSync("/tmp/FWUPGRADING");
  }
}

async function getUpgradeInfo() {
  const sysManager = require('./SysManager.js');
  let sysInfo = await sysManager.getSysInfoAsync();

  let tagBeforeUpgrade = fs.existsSync('/home/pi/.firewalla/run/upgrade-pre-tag')
    ? fs.readFileSync('/home/pi/.firewalla/run/upgrade-pre-tag', 'utf8').trim()
    : 'UnknownVersion';

  let result = {
    upgraded: sysInfo.repoTag && tagBeforeUpgrade != sysInfo.repoTag,
    from:     tagBeforeUpgrade,
    to:       sysInfo.repoTag
  }

  return result;
}

async function getCommitTS(hash) {
  const cmd = await exec(`git show -s --format=%ct ${hash}`)
  return Number(cmd.stdout.trim())
}

// only return hash & version of Firewalla
async function getHashAndVersion() {
  const localHash = await f.getLocalCommitHash()
  const localTS = await getCommitTS(localHash)
  const localVersion = config.getConfig().version
  let localVersionStr = String(localVersion)
  if (_.isNumber(localVersion)) {
    let exp = 0;
    while (!Number.isInteger(localVersion * Math.pow(10, exp)) && exp < 10)
      exp++;
    localVersionStr = config.getConfig().versionStr || localVersion.toFixed(Math.max(exp, 3))
  }
  try {
    const remoteHash = await f.getRemoteCommitHash()
    const remoteTS = await getCommitTS(remoteHash)
    let remoteVersion = localVersion
    let remoteVersionStr = localVersionStr
    if (localHash != remoteHash) {
      await exec(`timeout 20s git fetch origin ${remoteHash}`)
      const cmd = await exec(`git show ${remoteHash}:net2/config.json`)
      remoteVersion = JSON.parse(cmd.stdout).version
      if (_.isNumber(remoteVersion)) {
        let exp = 0;
        while (!Number.isInteger(remoteVersion * Math.pow(10, exp)) && exp < 10)
          exp++;
        remoteVersionStr = JSON.parse(cmd.stdout).versionStr || remoteVersion.toFixed(Math.max(exp, 3))
      }
    }

    return { localHash, localTS, localVersion, localVersionStr, remoteHash, remoteTS, remoteVersion, remoteVersionStr }
  } catch(err) {
    log.error('Error getting remote hash, local repo might be detached', err.message)
    return { localHash, localTS, localVersion }
  }
}

async function runInRouterHome(cmdStr) {
  const cmd = await exec(`cd ${f.getFireRouterHome()}; ${cmdStr}`)
  return cmd.stdout.trim()
}

async function getRouterCommitTS(hash) {
  return Number(await runInRouterHome(`git show -s --format=%ct ${hash}`))
}

async function getRouterHash() {
  const localHash = await runInRouterHome('git rev-parse @')
  const localTS = await getRouterCommitTS(localHash)
  try {
    // fetch won't print stdout
    const remoteHash = await runInRouterHome('timeout 20s git fetch origin; git rev-parse @{u}')
    const remoteTS = await getRouterCommitTS(remoteHash)

    return { localHash, localTS, remoteHash, remoteTS }
  } catch(err) {
    log.error('Error getting remote router hash, local repo might be detached', err.message)
    return { localHash, localTS }
  }
}

async function updateVersionTag() {
  const sysManager = require('./SysManager.js');
  let sysInfo = await sysManager.getSysInfoAsync()
  fs.writeFileSync('/home/pi/.firewalla/run/upgrade-pre-tag', sysInfo.repoTag, 'utf8');
}

async function getAutoUpgradeFlags() {
  const result = {}
  result.noAutoFW = await fileExist(NOAUTO_FLAG_PATH_FW)
  result.noCheckFW = await fileExist(NOCHECK_FLAG_PATH_FW)

  if (platform.isFireRouterManaged()) {
    result.noAutoFR = await fileExist(NOAUTO_FLAG_PATH_FR)
    result.noCheckFR = await fileExist(NOCHECK_FLAG_PATH_FR)
  }

  return result
}

async function getAutoUpgradeState() {
  const flags = await getAutoUpgradeFlags()
  const firewalla = !(flags.noAutoFW || flags.noCheckFW)

  if (platform.isFireRouterManaged()) {
    const firerouter = !(flags.noAutoFR || flags.noCheckFR)
    return { firewalla, firerouter }
  } else
    return { firewalla }
}


// defaults to true, note that setting FireRouter to no auto upgrade stops Firewalla from upgrading as well
async function setAutoUpgradeState(state) {
  const firewalla = _.get(state, 'firewalla', true)

  if (firewalla) {
    await fileRemove(NOAUTO_FLAG_PATH_FW)
    await fileRemove(NOCHECK_FLAG_PATH_FW)
  } else {
    await fileRemove(NOAUTO_FLAG_PATH_FW)
    await fileTouch(NOCHECK_FLAG_PATH_FW)
  }

  if (platform.isFireRouterManaged()) {
    const firerouter = _.get(state, 'firerouter', true)
    if (firerouter) {
      await fileRemove(NOAUTO_FLAG_PATH_FR)
      await fileRemove(NOCHECK_FLAG_PATH_FR)
    } else {
      await fileRemove(NOAUTO_FLAG_PATH_FR)
      await fileTouch(NOCHECK_FLAG_PATH_FR)
    }
  }
}

async function checkAndUpgrade(force) {
  return exec(`sudo systemctl start fireupgrade_cond@${force ? 'force' : 'check'}`)
}

module.exports = {
  isUpgrading:isUpgrading,
  finishUpgrade: finishUpgrade,
  getUpgradeInfo: getUpgradeInfo,
  updateVersionTag: updateVersionTag,

  getAutoUpgradeFlags,
  getAutoUpgradeState,
  setAutoUpgradeState,
  getHashAndVersion,
  getRouterHash,

  checkAndUpgrade,
};

