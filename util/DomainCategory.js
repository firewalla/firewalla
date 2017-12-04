'use strict';

const request = require('request');
const log = require("../net2/logger.js")(__filename);

class DomainCategory {
  constructor() {
    this.baseurl = "http://sitereview.bluecoat.com/rest/categorization"
    this.useragent = "Mozilla/5.0";
    this.timeout = 10000;
    this.regex = /<a.+?>(.*?)<\/a>/g;
  }

  _extract(str) {
    let result = [];
    let match = null;
    while (match = this.regex.exec(str)) {
      result.push(match[1]);
    }
    return result;
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

      let categories = null;
      try {
        let _body = JSON.parse(body);
        log.debug('_body:', _body, {});
        categories = this._extract(_body.categorization);
      } catch (err) {
        log.error('unable to obtain category', err, {});
      }
      cb(categories);
    });

  }
}

module.exports = new DomainCategory();
