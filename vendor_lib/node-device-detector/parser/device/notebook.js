const DeviceAbstractParser = require('./../device-abstract-parser');

const DEVICE_TYPE = require('./../const/device-type');

class Notebook extends DeviceAbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'device/notebooks.yml';
    this.loadCollection();
  }

  /**
   * @param userAgent
   * @returns {null|{model: string, id: string, type: string, brand: string}}
   */
  parse(userAgent) {
    if (!this.isFBMD(userAgent)) {
      return null;
    }
    let resultParse = super.parse(userAgent);

    if (resultParse) {
      let result = {
        id: '',
        type: DEVICE_TYPE.DESKTOP,
        brand: '',
        model: '',
      };
      result.id = resultParse.id;
      result.brand = resultParse.brand;
      result.model = resultParse.model;
      return result;
    }

    return null;
  }

  /**
   * has check userAgent fragment is FBMD
   * @param {String} userAgent
   * @return {Boolean}
   */
  isFBMD(userAgent) {
    let regex = 'FBMD/';
    let match = this.getBaseRegExp(regex).exec(userAgent);
    return match !== null;
  }
}

module.exports = Notebook;
