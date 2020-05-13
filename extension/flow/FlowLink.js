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

let instance = null;

const log = require('../../net2/logger.js')(__filename);
const rclient = require('../../util/redis_manager.js').getRedisClient();

// link flows across multiple bro source, conn/http/... and more in the future
class FlowLink {
  constructor() {
    if(instance === null) {
      instance = this;
    }

    return instance;
  }

  getFlowGraphKey(flowUID) {
    return `flowgraph:${flowUID}`;
  }

  async recordConn(flowUID, ts, options) {
    options = options || {};

    const expire = options.expire || 300 // 5 minutes

    const key = this.getFlowGraphKey(flowUID);

    await rclient.hsetAsync(key, "conn", ts);
    await rclient.expireAsync(key, expire);
  }

  async recordHttp(flowUID, ts, options) {
    options = options || {};

    const expire = options.expire || 300 // 5 minutes

    const key = this.getFlowGraphKey(flowUID);

    const content = {http: ts};
    if(options.mac) {
      content.mac = options.mac;
    }
    if(options.flowDirection) {
      content.flowDirection = options.flowDirection;
    }

    await rclient.hmsetAsync(key, content);
    await rclient.expireAsync(key, expire);
  }
}

module.exports = new FlowLink();
