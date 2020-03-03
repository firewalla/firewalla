/*    Copyright 2019 Firewalla INC
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

var crypto = require('crypto');

var PREFIX_BYTE_LENGTH = 4;

function getHashObject(expr) {
//  console.log("Hash of :",expr);
  var sha = crypto.createHash('sha256');
  sha.update(expr);
  var digest = sha.digest();

  return {
    hash: digest,
    prefix: getNormalizedPrefix(digest)
  };
}

function getNormalizedPrefix(hash) {
  return hash.slice(0, PREFIX_BYTE_LENGTH);
}

var Hashes = {
  getHashObject: getHashObject,
  getNormalizedPrefix: getNormalizedPrefix
};

module.exports = Hashes;
