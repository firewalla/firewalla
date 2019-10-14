/*    Copyright 2019 Firewalla LLC 
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
const log = require('../net2/logger.js')(__filename);

async function eachLimit(list, limit, producer) {
  let rest = list.slice(limit);
  await Promise.all(list.slice(0, limit).map(async item => {
    await producer(item);
    while (rest.length) {
      await producer(rest.shift());
    }
  }));
}

module.exports = {
  eachLimit
}
