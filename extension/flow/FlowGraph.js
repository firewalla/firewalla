'use strict';

let instance = null;

const log = require('../../net2/logger.js')(__filename);
const rclient = require('../../util/redis_manager.js').getRedisClient();

class FlowGraph {
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

module.exports = new FlowGraph();