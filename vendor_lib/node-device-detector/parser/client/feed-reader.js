const ClientAbstractParser = require('./../client-abstract-parser');

const CLIENT_TYPE = require('./../const/client-type');

class FeedReader extends ClientAbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'client/feed_readers.yml';
    this.loadCollection();
    this.collectionLength = this.collection.length;
    this.type = CLIENT_TYPE.FEED_READER;
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
        type: CLIENT_TYPE.FEED_READER,
      });

      return result;
    }

    return null;
  }
}

module.exports = FeedReader;
