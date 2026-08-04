const ParserAbstract = require('./abstract-parser');
const IndexerClient = require('./client/indexer-client');

class ClientAbstractParser extends ParserAbstract {
  constructor(options) {
    super(options);
    this.collectionLength = 0;
    this.type = '';
    this.__clientIndexes = true;
  }
  
  get clientIndexes() {
    return this.__clientIndexes;
  }
  
  set clientIndexes(stage) {
    this.__clientIndexes = stage;
  }
  
  /**
   * @param {string} userAgent
   * @param {*} clientHintData
   * @returns {{name: (string|*), type: string, version: string}|null}
   */
  parse(userAgent, clientHintData) {
    if (!userAgent) {
      return null;
    }
    userAgent = this.prepareUserAgent(userAgent);

    // scan indexes
    if (this.clientIndexes) {
     let result = this.parseUserAgentByPositions(userAgent);
      if (result !== null) {
        return result;
      }
    }
    
    // full scan
    for (let i = 0, l = this.collectionLength; i < l; i++) {
      let result = this.parseUserAgentByPosition(userAgent, i);
      if (result !== null) {
        return result;
      }
    }
    return null;
  }
  
  parseUserAgentByPositions(userAgent) {
    let positions = IndexerClient.findClientRegexPositionsForUserAgent(
      userAgent,
      String(this.type),
    );
    if (positions !== null && positions.length) {
      for (let i = 0, l = positions.length; i < l; i++) {
        let result = this.parseUserAgentByPosition(userAgent, positions[i]);
        if (result !== null) {
          return result;
        }
      }
    }
    return null;
  }
  
  /**
   * Inline parse userAgent by position collection
   *
   * @param {String} userAgent
   * @param {Number} position
   * @returns {{name: (string|*), type: string, version: string}|null}
   */
  parseUserAgentByPosition(userAgent, position = 0) {
    let item = this.collection[position];
    
    if (item === void 0) {
      return null;
    }
    
    let regex = this.getBaseRegExp(item.regex);
    let match = regex.exec(userAgent);
    
    if (match !== null) {
      return {
        type: String(this.type),
        name: this.buildByMatch(item.name, match),
        version: this.buildVersion(item.version, match),
      };
    }
    
    return null;
  }
}

module.exports = ClientAbstractParser;
