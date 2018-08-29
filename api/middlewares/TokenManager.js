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
    this.tokens = {};
  }

  generateToken(gid) {
    this.token[gid] = uuid.v4();
    return this.token[gid];
  }

  getToken(gid) {
    return this.token[gid];
  }

  validateToken(token) {
    for (gid in this.tokens) {
      if (this.token[gid] == token) {
        return gid;
      }
    }
    return null;
  }

  revokeToken(gid) {
    this.token[gid] = null;
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
