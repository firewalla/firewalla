'use strict';
const fs = require("fs");

const log = require('./logger.js')(__filename);

const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');

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
    upgraded: tagBeforeUpgrade != sysInfo.repoTag,
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

