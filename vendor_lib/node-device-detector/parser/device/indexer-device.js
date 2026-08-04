const helper = require("../helper");

const file = 'device-index-hash.yml';

class IndexerDevice {
  static findDeviceBrandsForDeviceCode(deviceCode) {
    if (!IndexerDevice.ready()) {
      return null;
    }

    let lDeviceCode = deviceCode.toLowerCase();
    let brands = this.collection[lDeviceCode];
    if (brands !== void 0) {
      return brands;
    }

    return [];
  }

  static ready() {
    return this.collection !== void 0;
  }

  static init(path) {
    if (helper.hasFile(path + file)) {
      this.collection = helper.loadYMLFile(path + file);
    }
  }

}

module.exports = IndexerDevice;
