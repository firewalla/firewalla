'use strict';

const CloudAction = require('./CloudAction.js');
const log = require('../../net2/logger.js')(__filename);
const HostTool = require('../../net2/HostTool.js');
const hostTool = new HostTool();

class MonitoringOnAction extends CloudAction {

  requiredKeys() {
    return ["hostID"];
  }

  async run(info = {}) {
    // hostID is hash, need to find the mac address mapping to the hostID
    const mac = await hostTool.findMacByMacHash(info.hostID);
    if(!mac) {
      log.error("Mac Address not found for hash", info.hostID);
      return false;
    }

    const HostManager = require('../../net2/HostManager.js');
    const hm = new HostManager('cli', 'client');
    const host = await hm.getHostAsync(mac);
    if(!host) {
      log.error(`Host not found for mac ${mac}`);
      return false;
    }

    await host.setPolicyAsync("monitor", true);
    return true;
  }
}

module.exports = MonitoringOnAction;