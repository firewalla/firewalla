const DeviceAbstractParser = require('./../device-abstract-parser');

class CarBrowser extends DeviceAbstractParser {
  constructor(options) {
    super(options);
    this.fixtureFile = 'device/car_browsers.yml';
    this.loadCollection();
  }
}

module.exports = CarBrowser;
