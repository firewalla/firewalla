/*    Copyright 2016 Firewalla LLC
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

const rclient = require('../util/redis_manager.js').getRedisClient()

const Promise = require('bluebird');

let instance = null;
class SystemPolicyTool {
  constructor() {
    if(!instance) {
      instance = this;
    }
    return instance;
  }
  
  isPolicyEnabled(policyKey) {
    return rclient.hgetAsync("policy:system", policyKey)
      .then((policy) => {
        if(policy === null || policy === "false") {
          return false;
        } else {
          return true;
        }
      })
  }
}

module.exports = function() {
  return new SystemPolicyTool();
}