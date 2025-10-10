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

let log = require('../net2/logger')(__filename);

let sample = require('./sample_data');
let license = require('../util/license.js');

let IntelTool = require('../net2/IntelTool');
let intelTool = new IntelTool();

let Bootstrap = require('../net2/Bootstrap');


describe.skip('IntelTool', () => {

  describe('._parseX509Subject', () => {

    it('should parse subject correctly', (done) => {
      let subject = "CN=*.crashlytics.com,OU=COMODO SSL Wildcard,OU=Domain Control Validated";
      let result = intelTool._parseX509Subject(subject);

      expect(result.CN).to.equal('*.crashlytics.com');
      expect(result.OU).to.equal('Domain Control Validated');
      done();
    });

  });

  describe('.getSSLCertificate', () => {

    beforeEach((done) => {
      (async() =>{
        await sample.addSampleSSLInfo();
        done();
      })();
    })

    afterEach((done) => {
      (async() =>{
        await sample.removeSampleSSLInfo();
        done();
      })();
    })

    it('should get ssl certificate correctly', (done) => {
      (async() =>{
        let result = await intelTool.getSSLCertificate(sample.hostIP);
        expect(result.server_name).to.equal('www.google.com');
        expect(result.CN).to.equal('*.google.com');
        expect(result.OU).to.equal('ABCDEF');
        done();
      })();
    })
  });

  describe('.getDNS', () => {

    beforeEach((done) => {
      (async() =>{
        await sample.addSampleDNSInfo();
        done();
      })();
    })

    afterEach((done) => {
      (async() =>{
        await sample.removeSampleDNSInfo();
        done();
      })();
    })

    it('should get dns info correctly', (done) => {
      (async() =>{
        let result = await intelTool.getDNS(sample.hostIP);
        expect(result).to.equal('www.google.com');
        done();
      })();
    })

  });

  describe.skip('.checkIntelFromCloud', function () {
    this.timeout(10000);

    before((done) => {
      (async() =>{
        await license.writeLicenseAsync(sample.sampleLicense);
        await Bootstrap.bootstrap();
        done();
      })();
    })

    beforeEach((done) => {
      intelTool.debugMode = false;
      done();
    });

    it('should be able to load youtube info from Cloud successfully (debug-mode)', (done) => {
      (async() =>{
        intelTool.debugMode = true;
        let result = await intelTool.checkIntelFromCloud([], ["youtube.com"]);
        expect(result.length).to.equal(1);
        let r1 = result[0];
        expect(r1.ip).to.equal('LvOZqM9U3cK9V1r05/4lr38ecDvgztKSGdyzL4bvE8c=');
        expect(r1.c).to.equal('av');
        expect(r1.cs).to.equal('["social"]');
        // expect(r1.apps).to.not.equal(undefined);
        // expect(r1.apps.youtube).to.equal('100');
        done();
      })();
    })

    it.skip('should be able to load wechat info from Cloud successfully (debug-mode)', (done) => {
      (async() =>{
        intelTool.debugMode = true;
        let result = await intelTool.checkIntelFromCloud([], ["hkshort.weixin.qq.com"]);
        expect(result.length).to.equal(2);
        log.debug(result);
        let r1 = result[0];
        expect(r1.ip).to.equal('hkshort.weixin.qq.com');
        expect(r1.apps).to.not.equal(undefined);
        expect(r1.apps.wechat).to.equal('100');
        done();
      })();
    })

    it('should be able to load youtube info from Cloud successfully (non-debug-mode)', (done) => {
      (async() =>{
        let result = await intelTool.checkIntelFromCloud([], ["youtube.com"]);
        expect(result.length).to.equal(1);
        log.debug(result);
        let r1 = result[0]
        expect(r1.ip).to.equal('LvOZqM9U3cK9V1r05/4lr38ecDvgztKSGdyzL4bvE8c=');
        expect(r1.c).to.equal('av')
        expect(JSON.parse(r1.cs)[0]).to.equal('social');
        done();
      })();
    })

    it.skip('should be able to load wechat info from Cloud successfully (non-debug-mode)', (done) => {
      (async() =>{
        let result = await intelTool.checkIntelFromCloud([], ["hkshort.weixin.qq.com"]);
        console.log(result);
        expect(result.length).to.equal(1);
        log.debug(result);
        let r1 = result[0];
        expect(r1.ip).to.equal('LvOZqM9U3cK9V1r05/4lr38ecDvgztKSGdyzL4bvE8c=');
        // expect(r1.c).to.equal('av')
        // expect(JSON.parse(r1.cs)[0]).to.equal('social');
        done();
      })();
    })
  })

  describe('.addIntel', () => {

    it('should add intel to redis correctly', (done) => {

      let intel = {
        ip: sample.hostIP,
        host: 'www.google.com',
        apps: JSON.stringify({search_engine: '100'})
      };

      (async() =>{
        await intelTool.addIntel(sample.hostIP, intel)
        let e = await intelTool.intelExists(sample.hostIP);
        expect(e).to.equal(true);
        let r = await intelTool.getIntel(sample.hostIP);
        expect(r.ip).to.equal(sample.hostIP);
        expect(r.host).to.equal('www.google.com')
        expect(JSON.parse(r.apps).search_engine).to.equal('100');
        intelTool.removeIntel(sample.hostIP)
        done();
      })();
    })

  })

  describe('.appExists', () => {
    beforeEach((done) => {
      sample.addSampleIntelInfo()
      .then(() => done())
    })

    afterEach((done) => {
      sample.removeSampleIntelInfo()
      .then(() => done())
    })

    it('should be able to check whether this ip is related to any app', (done) => {
      (async() =>{
        let result = await intelTool.appExists(sample.destIP);
        expect(result).to.equal(true);
        done();
      })();

    })
  })

});
