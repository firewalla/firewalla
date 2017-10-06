'use strict';
var childProcess = require('child_process');
let redis = require('redis');
let rclient = redis.createClient();

/*
 * If the system is upgrading ... 
 */
function isUpgrading() {
    return require('fs').existsSync("/tmp/FWUPGRADING");
}

/* 
 * Mark the system finished rebooting after reboot
 */

function finishUpgrade() {
    if (require('fs').existsSync("/tmp/FWUPGRADING")) {
        require("fs").unlinkSync("/tmp/FWUPGRADING");
    }
}

function getUpgradeInfo(callback) {
    rclient.get("sys:upgrade",(err,data)=>{ 
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

