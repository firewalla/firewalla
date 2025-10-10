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

let Bootstrap = require('../net2/Bootstrap');

let license = require('../util/license');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let sample = require('./sample_data');
let intelSample = require('./sample_data_intel');

let flowUtil = require('../net2/FlowUtil.js');


describe('FlowUtil', function () {

  describe('.hashApp', function () {

    it('should hash app correctly (netflix)', (done) => {
      let host = "api-global.latency.prodaa.netflix.com";
      let alist = flowUtil.hashApp(host);
      expect(alist.length).to.equal(3);
      expect(alist[0]).to.equal('fq787vyvqNs/FZVEQj2x/u8AQ7y/bnULrU9KlZboJUA=')
      expect(alist[1]).to.equal('881O2BHs1IblNU3yjYaS21YWdlJFP/tH32u3WZ+bun0=')
      expect(alist[2]).to.equal('oSRIwiHv3zgeC+XXVUm4PiQHNB58pqOk6F93nxQ4NQM=')
      done();
    })

    it('should hash app correctly (pinterest)', (done) => {
      let host = "log.pinterest.com";
      let alist = flowUtil.hashApp(host);
      console.log(alist);
      expect(alist.length).to.equal(2);
      expect(alist[0]).to.equal('bnmxO/hXWYl/0dXnynv9J1ZGQulFv1iar+eeLEBPEQk=')
      expect(alist[1]).to.equal('DTeOz77UssjWXsGTBKZQ7pR+TiXxB6DurYBP+/UzlMY=')
      done();
    })
  })

});
