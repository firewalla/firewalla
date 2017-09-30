'use strict';
var childProcess = require('child_process');

function isUpgrading() {
    return require('fs').existsSync("/tmp/FWUPGRADING");
}

function finishUpgrade() {
    require("fs").unlinkSync("/tmp/FWUPGRADING");
}

module.exports = {
    isUpgrading:isUpgrading,
    finishUpgrade: finishUpgrade 
};


