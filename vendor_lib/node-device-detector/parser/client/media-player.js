const ClientAbstractParser = require('./../client-abstract-parser');

const CLIENT_TYPE = require('./../const/client-type');

class MediaPlayer extends ClientAbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'client/mediaplayers.yml';
    this.loadCollection();
    this.collectionLength = this.collection.length;
    this.type = CLIENT_TYPE.MEDIA_PLAYER;
  }

  /**
   * @param {string} userAgent
   * @param clientHintsData
   * @returns {({name: (string|*), type: string, version: string} & {type: string})|null}
   */
  parse(userAgent, clientHintsData) {
    let result = super.parse(userAgent, clientHintsData);
    if (result) {
      result = Object.assign(result, {
        type: CLIENT_TYPE.MEDIA_PLAYER,
      });
      return result;
    }
    return null;
  }
}

module.exports = MediaPlayer;
