const ParserAbstract = require('./abstract-parser');
const helper = require("./helper");

const OS_SYSTEMS = require('./os/os_systems');
const OS_FAMILIES = require('./os/os_families');
const ANDROID_APP_LIST = [
  'com.hisense.odinbrowser',
  'com.seraphic.openinet.pre',
  'com.appssppa.idesktoppcbrowser'
];
const CLIENTHINT_MAPPING = {
  'GNU/Linux': ['Linux'],
  'Mac': ['MacOS'],
};
const compareOsForClientHints = (brand) => {
  for(let mapName in CLIENTHINT_MAPPING){
    for(let mapBrand of CLIENTHINT_MAPPING[mapName]){
      if (brand.toLowerCase() === mapBrand.toLowerCase()) {
        return mapName;
      }
    }
  }
  return brand;
}

function comparePlatform(platform, bitness = '') {
  if (platform.indexOf('arm') !== -1) {
    return 'ARM';
  }
  if (platform.indexOf('mips') !== -1) {
    return 'MIPS';
  }
  if (platform.indexOf('sh4') !== -1) {
    return 'SuperH';
  }
  if (platform.indexOf('x64') !== -1 || (platform.indexOf('x86') !== -1 && bitness === '64')) {
    return 'x64';
  }

  if (platform.indexOf('x86') !== -1) {
    return 'x86';
  }
  return '';
}

class OsAbstractParser extends ParserAbstract {
  constructor(options) {
    super(options);
    this.fixtureFile = 'oss.yml';
    this.loadCollection();
  }

  /**
   * @param {string} name
   * @return {string}
   */
  parseOsFamily(name) {
    for (let family in OS_FAMILIES) {
      if (OS_FAMILIES[family].indexOf(name) !== -1) {
        return String(family);
      }
    }
    return '';
  }

  /**
   * Normalisation os name and get short code os
   *
   * @param name
   * @returns {{name: string, short: string}}
   */
  getOsDataByName(name) {
    let short = 'UNK';
    let lname = String(name).toLowerCase();
    for (let key in OS_SYSTEMS) {
      if (lname === String(OS_SYSTEMS[key]).toLowerCase()) {
        name = OS_SYSTEMS[key];
        short = key;
        break;
      }
    }
    return {name, short}
  }

  parseFromClientHints(clientHintsData) {
    if (!clientHintsData) {
      return null;
    }

    let name = '';
    let short = '';
    let version = '';
    let platform = '';

    if (clientHintsData.os) {
      platform = clientHintsData.os.platform;
      version = clientHintsData.os.version;
      let hintName = clientHintsData.os.name;
      platform  = comparePlatform(platform.toLowerCase(), clientHintsData.os.bitness);
      hintName = compareOsForClientHints(hintName);

      for (let osShort in OS_SYSTEMS) {
        let osName = OS_SYSTEMS[osShort];
        if (helper.fuzzyCompare(hintName, osName)) {
          name = String(osName);
          short = String(osShort);
          break;
        }
      }
    }

    if (name === 'Windows' && version !== '') {
      let majorVersion = ~~version.split('.', 1)[0];
      if (majorVersion === 0) {
        version = "";
      }
      if (majorVersion > 0 && majorVersion < 11) {
        version = "10";
      } else if (majorVersion > 10) {
        version = "11";
      }
    }

    return {
      name: name,
      short_name: short,
      version: version,
      platform: platform,
    }
  }

  parseFromUserAgent(userAgent) {
    if (!userAgent) {
      return null;
    }
    for (let i = 0, l = this.collection.length; i < l; i++) {
      let item = this.collection[i];
      let regex = this.getBaseRegExp(item.regex);
      let match = regex.exec(userAgent);
      if (match !== null) {
        let {
          name,
          short
        } = this.getOsDataByName(this.buildByMatch(item.name, match))

        let version = item.version !== void 0
            ? this.buildVersion(item.version, match)
            : '';

        if (item.versions !== void 0) {
          for (let versionItem of item.versions) {
            let regex = this.getBaseRegExp(versionItem.regex);
            let match = regex.exec(userAgent);
            if (match !== null) {
              version = this.buildVersion(versionItem.version, match)
              break;
            }
          }
        }

        return {
          name: name,
          short_name: short,
          version: version,
          platform: this.parsePlatform(userAgent),
          family: this.parseOsFamily(short),
        };
      }
    }

    return null;
  }

  /**
   *
   * @param {string} userAgent
   * @param clientHints
   * @returns {null|{name: (string|*), short_name: string, family: string, version: string, platform: string}}
   */
  parse(userAgent, clientHints) {
    userAgent = this.prepareUserAgent(userAgent);
    let hint = this.parseFromClientHints(clientHints);
    let data = this.parseFromUserAgent(userAgent);

    let name= '', version= '', platform = '', short = '', family = '';

    if (hint && hint.name) {
      name = hint.name;
      version = hint.version;
      platform = hint.platform;
      short = hint.short_name;

      // use version from user agent if non was provided in client hints, but os family from useragent matches
      if (version === '' && data && this.parseOsFamily(short) === data.family) {
        version = data.version;
      }

      //If the OS name detected from client hints matches the OS family from user agent
      // but the os name is another, we use the one from user agent, as it might be more detailed
      if (data && data.family === name && data.name !== name) {
        name = data.name;
      }
  
      if ('HarmonyOS' === name) {
        version = '';
        short = 'HAR';
      }
      
      if ('GNU/Linux' === name
        && data
        && 'Chrome OS' === data.name
        && version === data.version
      ) {
        name  = data.name;
        short = data.short_name;
      }

      family = this.parseOsFamily(short);
    }

    if (clientHints
      && data
      && clientHints.app
      && ANDROID_APP_LIST.indexOf(clientHints.app) !== -1
      && data.name !== 'Android'
    ){
      name = 'Android';
      short = 'ADR';
      family = 'Android';
    }

    if (platform === '' && data) {
      platform = data.platform;
    }

    if (name === '') {
      return data;
    }

    return {
      name: String(name),
      version: String(version),
      short_name: String(short),
      platform: String(platform),
      family: String(family),
    };
  }

  /**
   * parse ua platform
   * @param {string} userAgent
   * @return {string}
   */
  parsePlatform(userAgent) {
    if (
        this.getBaseRegExp('arm|aarch64|Apple ?TV|Watch ?OS|Watch1,[12]').test(userAgent)
    ) {
      return 'ARM';
    }
    if (this.getBaseRegExp('mips').test(userAgent)) {
      return 'MIPS';
    }
    if (this.getBaseRegExp('sh4').test(userAgent)) {
      return 'SuperH';
    }
    if (this.getBaseRegExp('64-?bit|WOW64|(?:Intel)?x64|WINDOWS_64|win64|amd64|x86_?64').test(userAgent)) {
      return 'x64';
    }
    if (this.getBaseRegExp('.+32bit|.+win32|(?:i[0-9]|x)86|i86pc').test(userAgent)) {
      return 'x86';
    }

    return '';
  }
}

module.exports = OsAbstractParser;
