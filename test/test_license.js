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

let async = require('asyncawait/async');
let await = require('asyncawait/await');

describe('License', function() {

  describe('.writeLicense', () => {
    beforeEach((done) => {
      async(() => {
        try {
          await (fs.unlinkAsync(license.licensePath));
        } catch(err) {
          // ignore
        }

        done();
      })();
    })

    afterEach((done) => {
      async(() => {
        try {
          await (fs.unlinkAsync(license.licensePath));
        } catch(err) {
          // ignore
        }

        done();
      })();
    })

    it('should write license correctly', (done) => {
      async(() => {
        await (license.writeLicense({test: 1}));
        let l = await(license.getLicenseAsync());
        expect(l.test).to.equal(1);

        let testLicense = { DATA:
                             { ORG: 'firewalla',
                               LOCATION: 'usa',
                               LVERSION: '1.0',
                               BVERSION: '1.0',
                             APPID: 'com.rottiesoft.pi',
                               APPSECRET: '4137f1d7-f28e-469e-b045-70e1d393ca4b',
                               UUID: '81244056-90b9-43f3-a5ae-8681bde09e58',
                               SUUID: '81244056',
                               LICENSE: 'A',
                               LID: '9c3b43c3-0f94-44aa-9ecb-8a18d48f5c89',
                               MAC: '02:84:95:00:c7:b7',
                               TS: 1503827787,
                               EID: '1FrEr-XKsFjlPM_K2iUJhg' },
                            SIGNATURE: 'jq+825WZyhJvBHMuCaHFGjsLABV7GKXO2/xxQo6zvWxmyE2c89vklBIQ2eh7YZeY7oXaEEXXSkUYSzw/sP8WyBmiKCsXHs4/PnJjflMvIi0rshvGWGYJgwe9FTkUVGDDmy2Ef8MW/3TGTNxXZ9vLEtrTwi2d5QFL2ZBc0/LQOp8C8Tt7Zztbd3raUuyV8yscFM1i9B8D7PshSCfNKItN7o7ViIDZtSfsAPupg4B365weIjNUFkpd36PZjGE4GJ7UlrjxXmw1zOkUWOA+l/ezOecjQ0mGq0fdRSuMF5t7p5kykxRTiY6lCIYdOXbyZHRAjrCw8nCrN/pP0L+X+HNuCg4ZPvqp1rSc2Gzvt5v+AQJH0HNE4sLsyUpg2zj4bArIzml1E+q68CYNgjiuTTx9QRWLXRj1noz+kw5gFkfN2abNqAZQJ027AsELnJCEsJVC+I7y/EjI4LKyinkaVE5vJTiNqrlouzbnobx8hbWZIvU7KMnyQOEpO9pL7rvXJCELjkYM73GxfI15v6UGTFsxGf/aNXaBvOAf7zgy0/zvW0Vyktj2I/DMZiiDYrc5EVgnpLKW4ysEuGgaty262AonWa+K3S7EB0UFCp9n2eZzMioC9KDNpfCoJn5WZ9C16ftOz9Xuqr6FhmVPgUWfHmLsvXMUyzsowVw5Kqanxkj7plY=' }


        await (license.writeLicense(testLicense));
        let ll = await(license.getLicenseAsync());
        expect(ll.DATA.UUID).to.equal('81244056-90b9-43f3-a5ae-8681bde09e58');
        done();
      })();
    })
  });
});
