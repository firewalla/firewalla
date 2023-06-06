const ClientAbstractParser = require('./../client-abstract-parser');

const CLIENT_TYPE = require('./../const/client-type');

class Library extends ClientAbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'client/libraries.yml';
    this.loadCollection();
    this.collectionLength = this.collection.length;
    this.type = CLIENT_TYPE.LIBRARY;
  }

  /**
   *
   * @param userAgent
   * @param clientHintsData
   * @returns {({name: (string|*), type: string, version: string} & {type: string})|null}
   */
  parse(userAgent, clientHintsData) {
    let result = super.parse(userAgent, clientHintsData);
    if (result) {
      result = Object.assign(result, {
        type: CLIENT_TYPE.LIBRARY,
      });
      return result;
    }
    return null;
  }
}

module.exports = Library;
