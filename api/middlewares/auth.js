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

let tm = require('./TokenManager').getInstance();

module.exports = function(req, res, next) {
  let gid = tm.validateToken(req.headers['authorization'])
  if (req.headers && gid) {
    req._gid = gid;
    next();
  } else {
    let err = new Error('Unauthorized');
    err.status = 401;
    next(err);
  }
};
