'use strict';

const rp = require('request-promise');
const log = require("../net2/logger.js")(__filename);

class DomainCategory {
  constructor() {
    this.baseurl = "http://sitereview.bluecoat.com/resource/lookup"
    this.useragent = "Mozilla/5.0";
    this.timeout = 10000;
  }
  
  // callback: function(category) { ... };
  async getCategory(url) {
    let options = {
      uri: this.baseurl,
      headers: {
        'User-Agent': this.useragent,
      },
      method: 'POST',
      body: {url, captcha: ''},
      timeout: this.timeout
    };

    rp.post(options).then(body => {
      let category = null;
      try {
        let _body = JSON.parse(body);
        log.debug('_body:', _body);
        if (Array.isArray(_body.categorization) && _body.categorization.length > 1) {
          category = _body.categorization[0];
        }
      } catch (err) {
        log.error('unable to obtain category', err, {});
      }
      return category;
    }).catch(err => {
        log.error('error when query domain category', err, {});
    });
  }
}

module.exports = new DomainCategory();
