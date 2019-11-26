/*    Copyright 2016 - 2019 Firewalla INC
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

let log = require('./logger.js')(__filename);

let instance = null;
class AppTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }

  getAppInfo(msg) {
    return msg.appInfo;
  }

  // when app supports providing app info, it means legacy flow info can be discarded
  isAppReadyToDiscardLegacyFlowInfo(appInfo) {
    if(appInfo && appInfo.version && appInfo.version >= "1.17")
      return true
    else
      return false;
  }

  isAppReadyToDiscardLegacyAlarm(appInfo) {
    if(appInfo)
      return true
    else
      return false;
  }
}

module.exports = function () {
  return new AppTool();
}
