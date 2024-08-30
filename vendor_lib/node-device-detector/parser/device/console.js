const DeviceAbstractParser = require('./../device-abstract-parser');

class Console extends DeviceAbstractParser {
  constructor(options) {
    super(options);
    this.fixtureFile = 'device/consoles.yml';
    this.loadCollection();
  }
}

module.exports = Console;
