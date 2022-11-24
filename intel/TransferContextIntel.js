/*    Copyright 2016-2020 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);

const Intel = require('./Intel.js');

const flowTool = require('../net2/FlowTool');

class TransferContextIntel extends Intel {

  async enrichAlarm(alarm) {
    const destIP = alarm["p.dest.ip"];
    const deviceMac = alarm["p.device.mac"];

    if(destIP && deviceMac) {

      const transfers = await flowTool.getTransferTrend(deviceMac, destIP);

      if(transfers) {
        alarm["e.transfer"] = JSON.stringify(transfers);
      }
    }
    
    return alarm;
  }

}

module.exports = TransferContextIntel
