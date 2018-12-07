/*    Copyright 2016 Firewalla LLC
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const rp = require('request-promise');
const log = require('../../net2/logger.js')(__filename);
const config = require('../../net2/config.js').getConfig();

let instance = null;

class Slack {
  constructor() {
    if(instance === null) {
      instance = this;      
    }
    
    this.url = config.slack && config.slack.url;

    return instance;
  }

  /*
   * curl -X POST -H 'Content-type: application/json' --data '{"text":"Hello, World!"}' https://hooks.slack.com/services/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
   */
  async postMessage(message) {

    if(!this.url) {
      log.error("Slack URL is not configured, skipping sending slack message");
      return;
    }

    const options = {
      uri: this.url,
      json: {
        text: message
      },
      method: 'POST'
    }

    try {
      await rp(options);
    } catch(err) {
      log.error("Failed to submit slack message, err:", err);
    }

  }
}

module.exports = new Slack();