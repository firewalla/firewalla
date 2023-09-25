/*    Copyright 2019-2023 Firewalla Inc.
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

const sysManager = require('./SysManager.js');
const f = require('./Firewalla.js')
const config = require('./config.js')
const platform = require('../platform/PlatformLoader.js').getPlatform();

const { fileExist, fileTouch, fileRemove } = require('../util/util.js');
const { rrWithErrHandling } = require('../util/requestWrapper.js')

const _ = require('lodash')
const { exec } = require('child-process-promise')

const NOAUTO_FLAG_PATH_FW = f.getUserConfigFolder() + '/.no_auto_upgrade'
const NOAUTO_FLAG_PATH_FR = f.getFireRouterConfigFolder() + '/.no_auto_upgrade'

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
  try {
    const remoteHash = await f.getRemoteCommitHash()
    const remoteTS = await getCommitTS(remoteHash)
    const remoteVersion = localHash == remoteHash ? localVersion :
      _.get(await rrWithErrHandling({
        uri: `https://raw.githubusercontent.com/firewalla/firewalla/${remoteHash}/net2/config.json`,
        json: true,
        maxAttempts: 3,
        retryDelay: 1000,
      }), 'body.version', null)

    return { localHash, localTS, localVersion, remoteHash, remoteTS, remoteVersion }
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
    const remoteHash = await runInRouterHome('git fetch origin; git rev-parse @{u}')
    const remoteTS = await getRouterCommitTS(remoteHash)

    return { localHash, localTS, remoteHash, remoteTS }
  } catch(err) {
    log.error('Error getting remote hash, local repo might be detached', err.message)
    return { localHash, localTS }
  }
}

async function updateVersionTag() {
  let sysInfo = await sysManager.getSysInfoAsync()
  fs.writeFileSync('/home/pi/.firewalla/run/upgrade-pre-tag', sysInfo.repoTag, 'utf8');
}

async function getAutoUpgradeState() {
  const firewalla = !(await fileExist(NOAUTO_FLAG_PATH_FW))

  if (platform.isFireRouterManaged()) {
    const firerouter = !(await fileExist(NOAUTO_FLAG_PATH_FR))
    return { firewalla, firerouter }
  } else
    return { firewalla }
}

// defaults to true, note that setting FireRouter to no auto upgrade stops Firewalla from upgrading as well
async function setAutoUpgradeState(state) {
  const firewalla = _.get(state, 'firewalla', true)

  if (firewalla)
    await fileRemove(NOAUTO_FLAG_PATH_FW)
  else
    await fileTouch(NOAUTO_FLAG_PATH_FW)

  if (platform.isFireRouterManaged()) {
    const firerouter = _.get(state, 'firerouter', true)
    if (firerouter)
      await fileRemove(NOAUTO_FLAG_PATH_FR)
    else
      await fileTouch(NOAUTO_FLAG_PATH_FR)
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

  getAutoUpgradeState,
  setAutoUpgradeState,
  getHashAndVersion,
  getRouterHash,

  checkAndUpgrade,
};

