'use strict';
var childProcess = require('child_process');

const rclient = require('../util/redis_manager.js').getRedisClient()
const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');
const fs = require("fs");

/*
 * If the system is upgrading ... 
 */
function isUpgrading() {
  return fs.existsSync("/tmp/FWUPGRADING");
}

/* 
 * Mark the system finished rebooting after reboot
 */
async function finishUpgrade() {
  if (fs.existsSync("/tmp/FWUPGRADING")) {
    let sysInfo = await sysManager.getSysInfoAsync()

    if (fs.existsSync('/tmp/BEGORE_UPGRADE_TAG')) {
      let tagBeforeUpgrade = fs.readSync('/tmp/BEGORE_UPGRADE_TAG').trim();

      // there's actually an version upgrade/change happened
      if (tagBeforeUpgrade != sysInfo.repoTag) {
        rclient.publish('System:Upgrade:Done', sysInfo.repoTag);
      }
    }

    fs.writeFileSync('/tmp/BEGORE_UPGRADE_TAG', sysInfo.repoTag, 'utf8');
    fs.unlinkSync("/tmp/FWUPGRADING");
  }
}

// sys:upgrade is used only in HARD mode
function getUpgradeInfo(callback) {
  rclient.get("sys:upgrade", (err, data)=>{
    if (callback) {
      callback(err,data);
    }
  });    
}

module.exports = {
  isUpgrading:isUpgrading,
  finishUpgrade: finishUpgrade, 
  getUpgradeInfo: getUpgradeInfo
};

