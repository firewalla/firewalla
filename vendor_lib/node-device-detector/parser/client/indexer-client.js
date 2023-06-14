const helper = require('../helper');
const CLIENT_TYPES = require('../const/client-type');

const CLIENT_TYPES_MAP = {}
CLIENT_TYPES_MAP[CLIENT_TYPES.BROWSER] = 0;
CLIENT_TYPES_MAP[CLIENT_TYPES.MOBILE_APP] = 1;
CLIENT_TYPES_MAP[CLIENT_TYPES.LIBRARY] = 2;
CLIENT_TYPES_MAP[CLIENT_TYPES.MEDIA_PLAYER] = 3;
CLIENT_TYPES_MAP[CLIENT_TYPES.FEED_READER] = 4;
CLIENT_TYPES_MAP[CLIENT_TYPES.PIM] = 5;

const file = 'client-index-hash.yml';

class IndexerClient {

  /**
   * @param {string} userAgent
   * @param {string} type
   * @returns {null|array}
   */
  static findClientRegexPositionsForUserAgent(userAgent, type) {
    if (!IndexerClient.ready()) {
      return null;
    }

    let index = CLIENT_TYPES_MAP[type];
    if (index === void 0) {
      return null;
    }

    let data = helper.splitUserAgent(userAgent);
    let positions = this.collection[data.hash];

    if (positions !== void 0 && positions[index] !== void 0) {
      return positions[index];
    }

    return null;
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

module.exports = IndexerClient;
