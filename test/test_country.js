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
'use strict'

let chai = require('chai');
let should = chai.should;
let expect = chai.expect;
let assert = chai.assert;

let country = require('../extension/country/country.js');

describe('Country', () => {

  describe('.getCountry', () => {

    it('should return the right countries for ip addresses', (done) => {
      let mappings = {
        "123.58.180.7": "CN",
        "151.101.73.67": "US",
        "97.64.107.97": "US",
        "58.38.224.108": "CN"
      }

      for(let ip in mappings) {
        expect(country.getCountry(ip)).to.equal(mappings[ip]);
      }
      done();
    })

  });

});
