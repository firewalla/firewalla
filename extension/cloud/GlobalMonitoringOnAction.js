'use strict';

const CloudAction = require('./CloudAction.js');

class GlobalMonitoringOnAction extends CloudAction {
  async run(info = {}) {
    const HostManager = require('../../net2/HostManager.js');
    const hm = new HostManager('cli', 'client');
    await hm.setPolicyAsync("monitor", true);
    return true;
  }
}

module.exports = GlobalMonitoringOnAction;