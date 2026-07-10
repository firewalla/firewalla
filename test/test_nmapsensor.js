/*    Copyright 2016-2025 Firewalla Inc.
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

let chai = require('chai');
let expect = chai.expect;

let NmapSensor = require('../sensor/NmapSensor');

describe('Test static methods', async () => {
  it('getOUI', async () => {
    expect(await NmapSensor.getOUI('20:6d:31:31:1a:30')).to.equal('FIREWALLA INC')
    expect(await NmapSensor.getOUI('8C:1F:64:FF:CA:30')).to.equal('Invendis Technologies India Pvt Ltd')
  })
})
