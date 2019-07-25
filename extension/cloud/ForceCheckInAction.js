'use strict';

const CloudAction = require('./CloudAction.js');
const log = require('../../net2/logger.js')(__filename);
const Promsie = require('bluebird');
const sem = require('../../sensor/SensorEventManager.js').getInstance();

module.exports = class extends CloudAction {
  async run() {
    return new Promise(resolve => {
      sem.sendEventToFireMain({
        type: 'CloudReCheckin',
        message: "",
      });

      sem.once("CloudReCheckinComplete", async (event) => {
        resolve();
      })
    });
  }
}