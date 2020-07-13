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

class GlobalMonitoringOnAction extends CloudAction {
  async run(info = {}) {
    const HostManager = require('../../net2/HostManager.js');
    const hm = new HostManager();
    await hm.setPolicyAsync("monitor", true);
    return true;
  }
}

module.exports = GlobalMonitoringOnAction;
