'use strict';

let instance = null;

const SSClient = require('./ss_client.js');
const rclient = require('../../util/redis_manager').getRedisClient();

class SSClientManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.ssClientMap = {};
    }
    return instance;
  }

  async getSSClient(name = "default") {
    if(!this.ssClientMap[name]) {
      const configJSON = await rclient.getAsync("scisurf.config");
      try {
        let config = JSON.parse(configJSON);
        if(Array.isArray(config)) {
          if(config.length === 0) {
            return null;
          } else {
            config = config[0];
            this.ssClientMap[name] = new SSClient(Object.assign({}, config, {name}));
          }
        }
      } catch (err) {
        log.error("Failed to load ss config, err:", err);
        return null;
      }
    }

    return this.ssClientMap[name];
  }
}

module.exports = new SSClientManager();