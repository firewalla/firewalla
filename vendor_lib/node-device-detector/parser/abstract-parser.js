const helper = require('./helper');
const BASE_REGEXES_DIR = __dirname + '/../regexes/';

/**
 * @param {string} result
 * @return {string}
 */
function fixStringName(result) {
  return result.replace(new RegExp('_', 'g'), ' ')
      .replace(/ TD$/i, '');
}

/**
 * @param {string} result
 * @return {string}
 */
function fixStringVersion(result) {
  result = result.replace(new RegExp('_', 'g'), '.');
  result = result.replace(new RegExp('[.]$', 'g'), '');
  return result.trim();
}

class ParserAbstract {
  constructor() {
    this.fixtureFile = null;
    this.collection = null;
    this.type = null;
    this.versionTruncation = null;
    this.maxUserAgentSize = null;
  }

  /**
   * load collection
   */
  loadCollection() {
    this.collection = this.loadYMLFile(this.fixtureFile);
  }

  /**
   * load yaml file
   * @param {string} file
   * @returns {*}
   */
  loadYMLFile(file) {
    return helper.loadYMLFile(BASE_REGEXES_DIR + file);
  }

  /**
   * A special method that overwrites placeholders in a string
   * @param {string} item
   * @param {array} matches
   * @return {string|*}
   */
  buildByMatch(item, matches) {
    item = item || '';
    item = item.toString();
    let max = matches.length-1 || 1;
    if (item.indexOf('$') !== -1) {
      for (let nb = 1; nb <= max; nb++) {
        if (item.indexOf('$' + nb) === -1) {
          continue;
        }
        let replace = matches[nb] !== void 0 ? matches[nb] : '';
        item = item.replace(new RegExp('\\$' + nb, 'g'), replace);
      }
    }
    return item;
  }

  /**
   * helper prepare base regExp + part regExp
   * @param {string} str
   * @return {RegExp}
   */
  getBaseRegExp(str) {
    str = str.replace(new RegExp('/', 'g'), '\\/');
    str = str.replace(new RegExp('\\+\\+', 'g'), '+');
    str = '(?:^|[^A-Z0-9_-]|[^A-Z0-9-]_|sprd-|MZ-)(?:' + str + ')';
    return new RegExp(str, 'i');
  }

  /**
   * @param {string} model
   * @param matches
   * @return {*}
   */
  buildModel(model, matches) {
    model = fixStringName(this.buildByMatch(model, matches));
    return model === 'Build' ? null : model;
  }

  /**
   * Set the number of characters in the version where number is the number of characters +1
   * There is a line string version 1.2.3.4.555
   * If you set 0 we get version 1, if 2 we get 1.2.3 and so on.
   * @param {number} num
   */
  setVersionTruncation(num) {
    this.versionTruncation = num;
  }

  /**
   * Set string size limit for the useragent
   * @param {number} size
   */
  setMaxUserAgentSize(size) {
    this.maxUserAgentSize = size;
  }

  /**
   * Prepare user agent for restrict rules
   * @param {string|*} userAgent
   * @returns {string|*}
   */
  prepareUserAgent(userAgent) {
    if (userAgent && this.maxUserAgentSize && this.maxUserAgentSize < userAgent.length) {
      return String(userAgent.substr(0, this.maxUserAgentSize));
    }
    return userAgent;
  }

  /**
   * @param {string|number} version
   * @param {array} matches
   * @return {string}
   */
  buildVersion(version, matches) {
    version = fixStringVersion(this.buildByMatch(version, matches));
    const skipVersion = ['Portable', ''];
    if (skipVersion.indexOf(version) !== -1) {
      return version;
    }
    return helper.versionTruncate(version, this.versionTruncation);
  }
}

module.exports = ParserAbstract;
