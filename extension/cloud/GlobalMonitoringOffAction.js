'use strict';

const CloudAction = require('./CloudAction.js');
const log = require('../../net2/logger.js')(__filename);

class GlobalMonitoringOffAction extends CloudAction {
  async run(info = {}) {
    const HostManager = require('../../net2/HostManager.js');
    const hm = new HostManager('cli', 'client');
    await hm.setPolicyAsync("monitor", false);
    return true;
  }
}

module.exports = GlobalMonitoringOffAction;