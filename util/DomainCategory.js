'use strict';

const rp = require('request-promise');
const log = require("../net2/logger.js")(__filename);

class DomainCategory {
  async getCategory(url) {
    return rp.post({
      uri: "http://sitereview.bluecoat.com/resource/lookup",
      headers: {'User-Agent': "Mozilla/5.0"},
      body: {url, captcha: ''},
      json: true,
      timeout: 10000, //ms
    }).then(body => {
      let category = null;
      try {
        if (Array.isArray(body.categorization) && body.categorization.length > 0) {
          category = body.categorization[0].name;
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
