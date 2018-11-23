'use strict';
const fs = require("fs");

const log = require('./logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient();
const pclient = require('../util/redis_manager.js').getPublishClient();
const SysManager = require('./SysManager.js');
const sysManager = new SysManager('info');

/*
 * If the system is upgrading ... 
 */
function isUpgrading() {
  return fs.existsSync("/home/pi/.firewalla/run/upgrade-inprogress");
}

/* 
 * Mark the system finished rebooting after reboot
 */
async function finishUpgrade() {
  let sysInfo = await sysManager.getSysInfoAsync()
  if (fs.existsSync("/home/pi/.firewalla/run/upgrade-inprogress")) {
    log.info('FinishUpgrade');

    let tagBeforeUpgrade = fs.existsSync('/home/pi/.firewalla/run/upgrade-pre-tag')
      ? fs.readFileSync('/home/pi/.firewalla/run/upgrade-pre-tag', 'utf8').trim()
      : 'UnknownVersion';

    // there's actually an version upgrade/change happened
    if (tagBeforeUpgrade != sysInfo.repoTag) {
      log.info('Actual upgrade happened, sending notification');
      pclient.publish('System:Upgrade:Done', sysInfo.repoTag);
    }

    fs.unlinkSync("/home/pi/.firewalla/run/upgrade-inprogress");
  }
  fs.writeFileSync('/home/pi/.firewalla/run/upgrade-pre-tag', sysInfo.repoTag, 'utf8');
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

