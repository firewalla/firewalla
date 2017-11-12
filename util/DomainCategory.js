'use strict';

const request = require('request');
const log = require("../net2/logger.js")(__filename);

class DomainCategory {
  constructor() {
    this.baseurl = "http://sitereview.bluecoat.com/rest/categorization"
    this.useragent = "Mozilla/5.0";
    this.timeout = 10000;
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
        log.error('error when query domain category', err, {});
        cb(null);
        return;
      }

      let category = null;
      try {
        let _body = JSON.parse(body);
        log.debug('_body:', _body, {});
        category = this._extract(_body.categorization);
      } catch (err) {
        log.error('unable to obtain category', err, {});
      }
      cb(category);
    });

  }
}

module.exports = new DomainCategory();