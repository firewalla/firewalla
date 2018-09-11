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

let instance = null;

const rp = require('request-promise');
const f = require('../net2/Firewalla.js');
const fConfig = require('../net2/config.js').getConfig();

class FWTokenManager {
  constructor() {
    if(instance === null) {
      instance = this;
      this.pubKeys = [];
      this.loadPubKeys();
    }

    return instance;
  }

  async loadPubKeys() {
    
  }

  async loadLocalPublicKeys() {

  }
  async getPublicKeys() {
    const folder = `${f.getHiddenFolder}/pubKeys`;
  }

  verify(token) {

  }
}

module.exports = FWTokenManager;