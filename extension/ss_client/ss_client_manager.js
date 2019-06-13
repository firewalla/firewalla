'use strict';

let instance = null;
const log = require('../../net2/logger.js')(__filename);

const SSClient = require('./ss_client.js');
const rclient = require('../../util/redis_manager').getRedisClient();

const log = require("../../net2/logger.js")(__filename);

const ssConfigKey = "scisurf.config";

class SSClientManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.ssClientMap = {};
    }
    return instance;
  }

  async getConfig(name = "default") {
    let key = `${ssConfigKey}`;
    if(name !== "default") {
      key = `scisurf.${name}.config`;
    }
    const configString = await rclient.getAsync(key);
    if(!configString) {
      return null;
    }
    
    try {
      let config = JSON.parse(configString);
      if(config.servers && Array.isArray(config.servers)) {
        if(config.servers.length === 0) {
          return null;
        } else {
          config = config.servers[0];
        }
      }
      return config;
    } catch(err) {
      log.error(`Failed to load ss config ${key}, err:`, err);
      return null;
    }
  }

  async getSSClient(name = "default") {
    if(!this.ssClientMap[name]) {
      let config = await this.getConfig(name);
      if(config) {
        this.ssClientMap[name] = new SSClient(Object.assign({}, config, {name}));
      } else {
        return null;
      }
    }

    return this.ssClientMap[name];
  }
}

module.exports = new SSClientManager();