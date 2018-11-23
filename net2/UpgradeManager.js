'use strict';
const fs = require("fs");

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient();
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
async function finishUpgrade() {
  if (fs.existsSync("/tmp/FWUPGRADING")) {
    log.info('FinishUpgrade');
    let sysInfo = await sysManager.getSysInfoAsync()

    if (fs.existsSync('/tmp/REPO_TAG_BEFORE_UPGRADE')) {
      let tagBeforeUpgrade = fs.readSync('/tmp/REPO_TAG_BEFORE_UPGRADE').trim();

      // there's actually an version upgrade/change happened
      if (tagBeforeUpgrade != sysInfo.repoTag) {
        log.info('Actual upgrade happened, sending notification');
        rclient.publish('System:Upgrade:Done', sysInfo.repoTag);
      }
    }

    fs.writeFileSync('/tmp/REPO_TAG_BEFORE_UPGRADE', sysInfo.repoTag, 'utf8');
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

