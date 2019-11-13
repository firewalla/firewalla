/*    Copyright 2019 Firewalla INC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

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
