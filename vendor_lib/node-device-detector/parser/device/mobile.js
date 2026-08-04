const DeviceAbstractParser = require('./../device-abstract-parser');

class Mobile extends DeviceAbstractParser {
  constructor(options) {
    super(options);
    this.fixtureFile = 'device/mobiles.yml';
    this.loadCollection();
  }
}

module.exports = Mobile;
