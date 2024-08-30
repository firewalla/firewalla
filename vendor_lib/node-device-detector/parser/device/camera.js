const DeviceAbstractParser = require('./../device-abstract-parser');

class Camera extends DeviceAbstractParser {
  constructor(options) {
    super(options);
    this.fixtureFile = 'device/cameras.yml';
    this.loadCollection();
  }
}

module.exports = Camera;
