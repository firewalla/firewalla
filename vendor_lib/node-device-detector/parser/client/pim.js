const ClientAbstractParser = require('./../client-abstract-parser');
const CLIENT_TYPE = require('./../const/client-type');

class PIM extends ClientAbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'client/pim.yml';
    this.loadCollection();
    this.collectionLength = this.collection.length;
    this.type = CLIENT_TYPE.PIM;
  }

  /**
   *
   * @param userAgent
   * @param clientHintsData
   * @returns {{name: (string|*), type: string, version: string} & {type: string}}
   */
  parse(userAgent, clientHintsData) {
    let result = super.parse(userAgent, clientHintsData);
    if (result) {
      result = Object.assign(result, {
        type: CLIENT_TYPE.PIM,
      });
      return result;
    }
  }
}

module.exports = PIM;
