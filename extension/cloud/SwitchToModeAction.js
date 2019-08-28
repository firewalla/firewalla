'use strict';

const CloudAction = require('./CloudAction.js');
const log = require('../../net2/logger.js')(__filename);
const mode = require('../../net2/Mode.js')
const modeManager = require('../../net2/ModeManager.js');

class SwitchToLimitedModeAction extends CloudAction {
  requiredKeys() {
    return ["targetMode"];
  }

  async run(info = {}) {
    const targetMode = info.targetMode;

    const curMode = await mode.getSetupMode()
    if (targetMode === curMode) {
      return true;
    }

    switch (targetMode) {
      case "spoof":
        modeManager.setAutoSpoofAndPublish()
        break;
      case "dhcp":
        modeManager.setDHCPAndPublish()
        break;
      case "none":
        modeManager.setNoneAndPublish()
        break;
      default:
        log.error("unsupported mode: " + targetMode);
        return false;
        break;
    }

    return true;
  }
}

module.exports = SwitchToLimitedModeAction;