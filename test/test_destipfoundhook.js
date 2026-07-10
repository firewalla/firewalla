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

let sem = require('../sensor/SensorEventManager.js').getInstance();

let sample = require('./sample_data');

let DestIPFoundHook = require('../hook/DestIPFoundHook');
let destIPFoundHook = new DestIPFoundHook();


describe.skip('DestIPFoundHook', () => {

  describe('.aggregateIntelResult', () => {

    it('should provide right aggregation info', (done) => {
      let sslInfo = {
        server_name: 'www.google.com',
        CN: '*.google.com',
        OU: 'ABCD'
      };

      let dnsInfo = {
        host: 'www2.google.com'
      };

      let cloudIntelInfos = [
        {
          ip: 'Vqe3pGQi4q/8PQyOIALyDDNR9Eg66ZEa1f4B/EF30bk=',
          apps: {
            'search_engine': '100'
          }
        }
      ];

      let result = destIPFoundHook.aggregateIntelResult(sample.hostIP, sslInfo, dnsInfo, cloudIntelInfos);

      expect(result.ip).to.equal(sample.hostIP);
      expect(result.host).to.equal('www.google.com');

      expect(typeof result.apps).to.equal('string');
      let apps = JSON.parse(result.apps);
      expect(apps.search_engine).to.equal('100');

      done();
    })

  });

});
