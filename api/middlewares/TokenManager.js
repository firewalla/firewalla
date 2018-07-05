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

let log = require('../../net2/logger.js')(__filename);
let uuid = require('uuid');

let instance = null;

class TokenManager {
  constructor() {
    this.token = null;
  }

  generateToken() {
    this.token = uuid.v4();
    return this.token;
  }

  getToken() {
    return this.token;
  }

  validateToken(token) {
    return this.token === token;
  }

  revoke() {
    this.token = null;
  }

}

function getInstance() {
  if(!instance) {
    instance = new TokenManager();
  }
  return instance;
}

module.exports = {
  getInstance:getInstance
}
