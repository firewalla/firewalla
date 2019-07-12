'use strict';

const config = require('./CloudManagerConfig.json');
const bone = require('../../lib/Bone.js');
const log = require('../../net2/logger.js')(__filename);
const _ = require('lodash');

class CloudManager {
  constructor() {

  }

  async run(action, info = {}) {
    if (!config) return;``

    const actions = Object.keys(config);
    if (actions.includes(action)) {
      try {
        const className = config[action] && config[action].name;
        const A = require(`./${className}.js`);
        const a = new A();
        log.info(`Running action ${className}...`);
        const requiredKeys = a.requiredKeys();
        if(!_.isEmpty(requiredKeys)) {
          for(const key of requiredKeys) {
            if(! key in info) {
              log.error("missing key", key);
              const result = false;
              return bone.cloudActionCallback({ action, info, result });
            }
          }
        }
        const result = await a.run(info);
        return bone.cloudActionCallback({ action, info, result });
      } catch (err) {
        log.error(`Got error when calling cloud action ${action}, err: ${err}`);
        return;
      }
    }

    return;
  }
}


module.exports = new CloudManager();