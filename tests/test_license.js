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

let _ = require('underscore');
let chai = require('chai');
let expect = chai.expect;
let should = chai.should;

let log = require('../net2/logger.js')(__filename, 'info');

let fs = require('fs');
let cp = require('child_process');

let assert = chai.assert;

let Promise = require('bluebird');
Promise.promisifyAll(fs);

let license = require('../util/license.js');

let sample = require('./sample_data');

describe.skip('License', function() {

  describe('.writeLicense', () => {
    beforeEach((done) => {
      (async() =>{
        try {
          await fs.unlinkAsync(license.licensePath)
        } catch(err) {
          // ignore
        }

        done();
      })();
    })

    afterEach((done) => {
      (async() =>{
        try {
          await fs.unlinkAsync(license.licensePath)
        } catch(err) {
          // ignore
        }

        done();
      })();
    })

    it('should write license correctly', (done) => {
      (async() =>{
        await license.writeLicense({test: 1})
        let l = await license.getLicenseAsync()
        expect(l.test).to.equal(1);

        let testLicense = sample.sampleLicense;
        await license.writeLicense(testLicense);
        let ll = await license.getLicenseAsync();
        expect(ll.DATA.UUID).to.equal('4dfb749e-94a1-4756-867b-4cf2c3e292db');
        done();
      })();
    })
  });
});
