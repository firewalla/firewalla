const header = require('./parser/helper');
const helper = require("./parser/helper");
const attr = header.getPropertyValue;

const CH_UA_FULL_VERSION = 'sec-ch-ua-full-version';
const CH_UA_FULL_VERSION_LIST = 'sec-ch-ua-full-version-list';
const CH_UA_MOBILE = 'sec-ch-ua-mobile';
const CH_UA_MODEL = 'sec-ch-ua-model';
const CH_UA_PLATFORM_VERSION = 'sec-ch-ua-platform-version';
const CH_UA_PLATFORM = 'sec-ch-ua-platform';
const CH_UA_ARCH = 'sec-ch-ua-arch';
const CH_UA = 'sec-ch-ua';
const CH_BITNESS = 'sec-ch-ua-bitness';
const CH_UA_PREFERS_COLOR_SCHEME = 'sec-ch-prefers-color-scheme';

/*
  sec-ch-ua',ua,
  sec-ch-ua-platform, ua-platform',
  sec-ch-ua-mobile,ua-mobile
  sec-ch-ua-full-version',ua-full-version,sec-ch-ua-full-version-list
  sec-ch-ua-platform-version,ua-platform-version,
  sec-ch-ua-arch,ua-arch,
  sec-ch-ua-bitness,ua-bitness,
  sec-ch-ua-model,ua-model,
  sec-ch-lang,lang,
  sec-ch-save-data,save-data,
  sec-ch-width, width,
  sec-ch-viewport-width,viewport-width,
  sec-ch-viewport-height,viewport-height,
  sec-ch-dpr,dpr,
  sec-ch-device-memory,device-memory,
  sec-ch-rtt,rtt,
  sec-ch-downlink,downlink,
  sec-ch-ect,ect,
  sec-ch-prefers-color-scheme,
  sec-ch-prefers-reduced-motion,
  sec-ch-prefers-reduced-transparency,
  sec-ch-prefers-contrast,sec-ch-forced-colors,
  sec-ch-prefers-reduced-data];
*/


function getBrowserNames(headers) {
  let value = attr(headers, CH_UA_FULL_VERSION_LIST, attr(headers, CH_UA, ''));

  let pattern = new RegExp('"([^"]+)"; ?v="([^"]+)"(?:, )?', 'gi');
  let items = [];
  let matches = null;
  while (matches = pattern.exec(value)) {
    let brand = matches[1];
    let skip = brand.indexOf('Not;A') !== -1
        || brand.indexOf('Not A;') !== -1
    if (skip) {
      continue
    }
    items.push({brand, version: helper.trimChars(matches[2], '"')});
  }
  return items;
}


class ClientHints {

  /**
   * @returns {{"accept-ch": ""}}
   * @example
   * ```js
      const hintHeaders = ClientHints.getHeaderClientHints();
      for (let name in hintHeaders) {
        res.setHeader(name, hintHeaders[headerName]);
      }
   * ```
   */
  static getHeaderClientHints() {
    return {
      'accept-ch': [
        'sec-ch-ua-full-version',
        'sec-ch-ua-full-version-list', 'sec-ch-ua-platform',
        'sec-ch-ua-platform-version',
        'sec-ch-ua-model',
        'sec-ch-ua-arch',
        'sec-ch-ua-bitness',
        'sec-ch-prefers-color-scheme',
      ].join(', ')
    };
  }

  /**
   * @param {{}} headers - key/value
   * @return {boolean}
   * @example
   * ```js
      console.log('is support client hints', ClientHints.isSupport(res.headers));
   * js
   */
  static isSupport(headers) {
    return headers[CH_UA] !== void 0
        || headers[CH_UA.toLowerCase()] !== void 0
        || headers[CH_UA_FULL_VERSION_LIST.toLowerCase()] !== void 0;
  }

  /**
   * @param objHeaders
   */
  parse(objHeaders) {
    let headers = {};
    for( let key in objHeaders) {
      headers[key.toLowerCase()] = objHeaders[key];
    }

    let result = {};
    result.upgradeHeader = headers[CH_UA_FULL_VERSION] !== void 0;

    result.isMobile = attr(headers, CH_UA_MOBILE, '') === '?1';
    result.prefers = {
      colorScheme: helper.trimChars(attr(headers, CH_UA_PREFERS_COLOR_SCHEME, ''), '"')
    }
    let osName = attr(headers, CH_UA_PLATFORM, '');
    let platform = attr(headers, CH_UA_ARCH, '');
    let bitness = attr(headers, CH_BITNESS, '');
    let osVersion = attr(headers, CH_UA_PLATFORM_VERSION, '');
    // os
    result.os = {
      name: helper.trimChars(osName, '"'),
      platform: helper.trimChars(platform.toLowerCase(), '"'),
      bitness: helper.trimChars(bitness, '"'),
      version: helper.trimChars(osVersion, '"')
    };

    // client
    let clientData = getBrowserNames(headers);
    result.client = {
      brands: clientData,
      version: helper.trimChars(attr(headers, CH_UA_FULL_VERSION, ''), '"'),
    };
    
    result.device = {
      model: helper.trimChars(attr(headers, CH_UA_MODEL, ''), '"')
    }

    let xRequested = attr(headers, 'x-requested-with',
      attr(headers, 'http-x-requested-with', '')
    );

    result.app = helper.trimChars(xRequested, '"')
    if (result.app.toLowerCase() === 'xmlhttprequest') {
      result.app = '';
    }

    return result;
  }

}

module.exports = ClientHints;