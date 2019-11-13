/*    Copyright 2018-2019 Firewalla INC
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

var fs = require('fs');

let firewalla = require('../../net2/Firewalla.js');
var fHome = firewalla.getFirewallaHome();

let tokenFile = fHome + '/api/db/token.json';
let tokens = loadTokens(tokenFile);

function loadTokens(tokenFile) {
  if(fs.existsSync(tokenFile)) {
    try {
      return JSON.parse(fs.readFileSync(tokenFile));
    } catch(error) {
      return [];
    }
  } else {
    // token file not found
    return [];
  }
}
exports.findByToken = function(token, cb) {
  process.nextTick(function() {
    for (var i = 0, len = tokens.length; i < len; i++) {
      var t = tokens[i];
      if (t === token) {
        return cb(null, t);
      }
    }
    return cb(null, null);
  });
}
