/*    Copyright 2019 Firewalla INC
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

async function updateVersionTag() {
  let sysInfo = await sysManager.getSysInfoAsync()
  fs.writeFileSync('/home/pi/.firewalla/run/upgrade-pre-tag', sysInfo.repoTag, 'utf8');
}

module.exports = {
  isUpgrading:isUpgrading,
  finishUpgrade: finishUpgrade,
  getUpgradeInfo: getUpgradeInfo,
  updateVersionTag: updateVersionTag
};

