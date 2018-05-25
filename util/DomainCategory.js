'use strict';

const rp = require('request-promise');
const log = require("../net2/logger.js")(__filename);

class DomainCategory {
  // callback: function(category) { ... };
  async getCategory(url) {
    return rp.post({
      uri: "http://sitereview.bluecoat.com/resource/lookup",
      headers: {
        'User-Agent': "Mozilla/5.0",
      },
      body: {url, captcha: ''},
      timeout: 10000 //ms
    }).then(body => {
      let category = null;
      try {
        let _body = JSON.parse(body);
        log.debug('_body:', _body);
        if (Array.isArray(_body.categorization) && _body.categorization.length > 1) {
          category = _body.categorization[0];
        }
      } catch (err) {
        log.error('unable to obtain category', err);
      }
      return category;
    }).catch(err => {
      log.error('error when query domain category', err);
    });
  }
}

module.exports = new DomainCategory();
