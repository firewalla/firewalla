const Promise = require('bluebird');
const request = Promise.promisifyAll(require('request'));
const async = require('asyncawait/async');
const await = require('asyncawait/await');

class SiteReview {
  constructor() {
    this.baseurl = "http://sitereview.bluecoat.com/rest/categorization"
    this.useragent = "Mozilla/5.0";
    this.timeout = 5000;
    this.regex = new RegExp('^!!<.+>(.+)<.+>$');
  }

  extractCategory(str) {
    let result = str.match(this.regex);
    if (result) {
      return result[1];
    } else {
      return null;
    }
  }

  // callback = (category) { ... };
  review(url, cb) {
    let body = "url="+ url;
    let options = {
      uri: sr.baseurl,
      headers: {
        'User-Agent': sr.useragent,
      },
      method: 'POST',
      body: body,
      timeout: sr.timeout
    };

    request.post(options, (err, res, body) => {
      if (err) {
        cb(null);
        return;
      }

      try {
        let _body = JSON.parse(res.body);
        let cat = _body.categorization;
        cat = this.extractCategory(cat);
        cb(cat);
      } catch (err) {
        console.error(err);
      }
    });

  }
}

module.exports = new SiteReview();