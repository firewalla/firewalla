const DeviceAbstractParser = require('./../device-abstract-parser');

class Console extends DeviceAbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'device/consoles.yml';
    this.loadCollection();
  }
}

module.exports = Console;
