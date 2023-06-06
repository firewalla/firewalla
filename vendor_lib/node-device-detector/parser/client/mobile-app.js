const ClientAbstractParser = require('./../client-abstract-parser');
const AppHints = require('./hints/app-hints');

const CLIENT_TYPE = require('./../const/client-type');

const appHints = new AppHints;

class MobileApp extends ClientAbstractParser {
  constructor() {
    super();
    this.fixtureFile = 'client/mobile_apps.yml';
    this.loadCollection();
    this.collectionLength = this.collection.length;
    this.type = CLIENT_TYPE.MOBILE_APP;
  }
  
  parseFromHashHintsApp(clientHints) {
    return appHints.parse(clientHints);
  }
  
  parseFromClientHints(clientHints) {
    let name = '';
    let version = '';
    return {name, version}
  }
  
  prepareParseResult(userAgent, data, hint, hash) {
    let name = '';
    let type = CLIENT_TYPE.MOBILE_APP;
    let version = '';
    
    if (data) {
      name = data.name;
      version = data.version;
    }
    
    if (hash && name !== hash.name) {
      name = hash.name;
      version = '';
    }
    
    if (name === '') {
      return null;
    }
    
    return {
      name: String(name),
      type: String(type),
      version: String(version),
    };
  }

  /**
   * @param userAgent
   * @param clientHints
   * @returns {({name: string, type: string, version: string})|null}
   */
  parse(userAgent, clientHints) {
    let hash = this.parseFromHashHintsApp(clientHints);
    let hint = this.parseFromClientHints(clientHints);
    let data = super.parse(userAgent, clientHints);
    return this.prepareParseResult(userAgent, data, hint, hash);
  }
}

module.exports = MobileApp;