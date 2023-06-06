const AbstractParser = require('./../abstract-parser');
const helper = require('./../helper');

const COLLECTION_BRAND_LIST = helper.revertObject(require('./brand-short'));

const createReplaceBrandRegexp = () => {
  let escapeeChars = [/\+/gi, /\./gi];
  let replaceChars = ['\\+', '\\.'];
  let customBrands = ['HUAWEI HUAWEI', 'viv-vivo'];
  let brands = customBrands.concat(Object.keys(COLLECTION_BRAND_LIST)).
  join('|');
  for (let i = 0, l = escapeeChars.length; i < l; i++) {
    brands = brands.replace(escapeeChars[i], replaceChars[i]);
  }
  return new RegExp(
      '(?:^|[^A-Z0-9-_]|[^A-Z0-9-]_|sprd-)(' + brands + ')[ _]',
      'isg',
  );
};

const normalizationUserAgent = (userAgent) => {
  let rawUA = String(userAgent)
  if (
      /;ip(?:ad|hone): build\//i.test(rawUA) &&
      /android /i.test(rawUA)
  ) {
    rawUA = rawUA.replace(/;ip(?:ad|hone):/i, '')
  }
  return rawUA
}

const REPLACE_BRAND_REGEXP = createReplaceBrandRegexp();

class AliasDevice extends AbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'device/alias-device.yml';
    this.__replaceBrand = true;
    this.loadCollection();
  }

  hasReplaceBrand() {
    return Boolean(this.__replaceBrand);
  }

  setReplaceBrand(replace) {
    this.__replaceBrand = replace;
  }

  /**
   * @param {string} userAgent
   * @returns {{name: string}}
   */
  parse(userAgent) {
    userAgent = this.prepareUserAgent(userAgent);
    userAgent = normalizationUserAgent(userAgent);
    let result = {
      name: '',
    };
    let decodeUserAgent = '';
    let isDecodeUA = /%[2-4][0-6A-F]/i.test(userAgent);
    try {
      decodeUserAgent = isDecodeUA ? decodeURIComponent(userAgent) : userAgent;
    } catch (err) {}

    for (let cursor in this.collection) {
      let item = this.collection[cursor];
      let match = this.getBaseRegExp(item['regex']).exec(decodeUserAgent);
      if (match) {
        result.name = this.buildByMatch(item['name'], match);
        if (this.hasReplaceBrand()) {
          result.name = result.name.replace(REPLACE_BRAND_REGEXP, '');
        }
        break;
      }
    }
    result.name = result.name.trim();
    return result;
  }

}

module.exports = AliasDevice;
