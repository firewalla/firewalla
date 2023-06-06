const helper = require("../helper");

let collection;
let path = __dirname + '/../../regexes/device-index-hash.yml';

class IndexerDevice {
  static findDeviceBrandsForDeviceCode(deviceCode) {
    if (!IndexerDevice.ready()) {
      return null;
    }

    let lDeviceCode = deviceCode.toLowerCase();
    let brands = collection[lDeviceCode];
    if (brands !== void 0) {
      return brands;
    }

    return [];
  }

  static ready() {
    return collection !== void 0;
  }

  static init() {
    if (helper.hasFile(path)) {
      collection = helper.loadYMLFile(path);
    }
  }

}

module.exports = IndexerDevice;