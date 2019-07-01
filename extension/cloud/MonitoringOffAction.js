'use strict';

const CloudAction = require('./CloudAction.js');
const log = require('../../net2/logger.js')(__filename);


class MonitoringOffAction extends CloudAction {
  async run(info = {}) {
    if(!info.hostID) {
      log.error("Require host ID for monitoring off action.");
      return;
    }

    const HostManager = require('../../net2/HostManager.js');
    const hm = new HostManager('cli', 'client');
    const host = await hm.getHostAsync(info.hostID);
    if(!host) {
      log.error(`Host not found for host id ${info.hostID}`);
      return;
    }

    const result = await host.setPolicyAsync("monitor", false);
    return result;
  }
}

module.exports = MonitoringOffAction;