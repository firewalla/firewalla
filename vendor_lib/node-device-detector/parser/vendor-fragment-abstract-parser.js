const ParserAbstract = require('./abstract-parser');
const helper = require('./helper');

const COLLECTION_BRAND_LIST = helper.revertObject(
    require('./device/brand-short')
);

class VendorFragmentAbstractParser extends ParserAbstract {
  constructor() {
    super();
    this.fixtureFile = 'vendorfragments.yml';
    this.loadCollection();
  }

  /**
   * @param userAgent
   * @returns {null|{name: string, id: string}}
   */
  parse(userAgent) {
    for (let cursor in this.collection) {
      let name = String(cursor);
      let collection = this.collection[name];

      for (let i = 0, l = collection.length; i < l; i++) {
        let item = collection[i];
        let pattern = item + '[^a-z0-9]+';
        let regex = this.getBaseRegExp(pattern);
        let match = regex.exec(userAgent);
        if (match !== null) {
          let brandId = COLLECTION_BRAND_LIST[name];
          return {
            name: name,
            id: brandId !== void 0 ? brandId : '',
          };
        }
      }
    }
    return null;
  }
}

module.exports = VendorFragmentAbstractParser;
