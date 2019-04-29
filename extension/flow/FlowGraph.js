'use strict';

let instance = null;

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

    const expire = option.expire || 1800 // 30 minutes

    const key = this.getFlowGraphKey(flowUID);

    await rclient.hsetAsync(key, "conn", ts);
    await rclient.expireAsync(key, expire);
  }

  async recordHttp(flowUID, ts, options) {
    options = options || {};

    const expire = option.expire || 1800 // 30 minutes

    const key = this.getFlowGraphKey(flowUID);

    await rclient.hsetAsync(key, "http", ts);
    await rclient.expireAsync(key, expire);
  }
}

module.exports = new FlowGraph();