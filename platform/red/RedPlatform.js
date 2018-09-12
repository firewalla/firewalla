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

const Platform = require('../Platform.js');
const f = require('../../net2/Firewalla.js')
const utils = require('../../lib/utils.js');

class RedPlatform extends Platform {
  getBoardSerial() {
    return utils.getCpuId();
  }

  getB4Binary() {
    return `${f.getFirewallaHome()}/bin/real.armv7l/bitbridge7`;
  }

  getB6Binary() {
    return `${f.getFirewallaHome()}/bin/real.armv7l/bitbridge6`;
  }
}

module.exports = RedPlatform;
