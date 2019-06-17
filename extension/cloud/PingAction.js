'use strict';

const CloudAction = require('./CloudAction.js');
const log = require('../../net2/logger.js')(__filename);

class PingAction extends CloudAction {
    async run(info = {}) {
        log.info("Ping... Pong...");
    }
}

module.exports = PingAction;