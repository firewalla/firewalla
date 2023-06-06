const ParserAbstract = require('./abstract-parser');

class BotAbstractParser extends ParserAbstract {
  constructor() {
    super();
    this.fixtureFile = 'bots.yml';
    this.loadCollection();
  }

  /**
   * parse user agent is bot
   * @param {string} userAgent
   * @returns {{name: string, producer: {}, category: string, url: string}|null}
   */
  parse(userAgent) {
    for (let i = 0, l = this.collection.length; i < l; i++) {
      let item = this.collection[i];
      let regex = this.getBaseRegExp(item.regex);
      let match = regex.exec(userAgent);

      if (match !== null) {
        let producer = item.producer ? item.producer : {};
        if (producer.name === null) {
          producer.name = '';
        }

        return {
          name: item.name ? item.name : '',
          category: item.category ? item.category : '',
          url: item.url ? item.url : '',
          producer: producer
        };
      }
    }
    return null;
  }
}

module.exports = BotAbstractParser;
