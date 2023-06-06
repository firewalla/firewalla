const DeviceAbstractParser = require('./../device-abstract-parser');

class Mobile extends DeviceAbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'device/mobiles.yml';
    this.loadCollection();
  }
}

module.exports = Mobile;
