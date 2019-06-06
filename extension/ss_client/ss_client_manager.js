'use strict';

let instance = null;

const SSClient = require('./ss_client.js');

class SSClientManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.ssClientMap = {};
    }
    return instance;
  }

  getSSClient(name = "default") {
    if(!this.ssClientMap[name]) {
      this.ssClientMap[name] = new SSClient(name);
    }

    return this.ssClientMap[name];
  }
}

module.exports = new SSClientManager();