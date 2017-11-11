'use strict';

const request = require('request');
const log = require("../net2/logger.js")(__filename);

class DomainCategory {
  constructor() {
    this.baseurl = "http://sitereview.bluecoat.com/rest/categorization"
    this.useragent = "Mozilla/5.0";
    this.timeout = 5000;
    this.regex = new RegExp('^<.+>(.+)<.+>$');
  }

  _extract(str) {
    let result = str.match(this.regex);
    if (result) {
      return result[1];
    } else {
      return null;
    }
  }

  // callback: function(category) { ... };
  getCategory(url, cb) {
    let body = "url="+ url;
    let options = {
      uri: this.baseurl,
      headers: {
        'User-Agent': this.useragent,
      },
      method: 'POST',
      body: body,
      timeout: this.timeout
    };

    request.post(options, (err, res, body) => {
      if (err) {
        log.error('error when query site getCategory', err, {});
        cb(null);
        return;
      }

      let cat = null;
      try {
        let _body = JSON.parse(body);
        log.debug('_body:', _body, {});
        cat = this._extract(_body.categorization);
      } catch (err) {
        log.debug('unable to extract category', err, {});
      }
      cb(cat);
    });

  }
}

module.exports = new DomainCategory();