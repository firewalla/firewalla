
const ArrayPath = require('./array-path');

class DataPacker {
  /**
   * pack objects to str
   * format: shortcode=value;
   * @param obj
   * @param shortKeys
   * @returns {string}
   */
  static pack(obj, shortKeys) {
    let data = [];
    for (let key in shortKeys) {
      let value = ArrayPath.get(obj, shortKeys[key]);
      data.push(`${key}=${value};`);
    }
    return data.join('');
  }
  
  /**
   * unpack string to objects
   * @param str
   * @param shortKeys
   * @returns {{}}
   */
  static unpack(str, shortKeys) {
    let regex = /([a-z]{2})=([^;]+)?;/gi;
    let obj = {};
    let match = null;
    while ((match = regex.exec(str))) {
      let short = match[1];
      let value = match[2] !== void 0 ? match[2] : '';
      let path = shortKeys[short];
      ArrayPath.set(obj, path, value, true);
    }
    return obj;
  }
}

module.exports = DataPacker;
