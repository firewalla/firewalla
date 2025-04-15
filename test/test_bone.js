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
let expect = chai.expect;

let Bootstrap = require('../net2/Bootstrap');
const networkTool = require('../net2/NetworkTool')();
const fc = require('../net2/config.js').getConfig();
const log = require('../net2/logger.js')(__filename);
const sysManager = require('../net2/SysManager.js');

const rclient = require('../util/redis_manager.js').getRedisClient()

let license = require('../util/license');

let sample = require('./sample_data');
let intelSample = require('./sample_data_intel');

describe.skip('Bone', function () {
  this.timeout(10000);

  describe('.getLicense', function() {
    before((done) => {
      (async() =>{
        await license.writeLicenseAsync(sample.sampleLicense);
        await Bootstrap.bootstrap();
        done();
      })();
    })

    it('should issue license correctly', (done) => {
      let licenseKey = "17f4c217-4508-4d05-9891-fe400e9ca0a6";
      let macAddress = "AA:BB:CC:AA:BB:DD";

      let bone = require("../lib/Bone.js");

      (async() =>{
        let result = await bone.getLicenseAsync(licenseKey, macAddress);
        expect(result.DATA).to.not.equal(undefined)
        expect(result.DATA.MAC).to.equal(macAddress);
        done();
      })();
    })
    it('should write license', async() => {
      let bone = require("../lib/Bone.js");

      const luid = await rclient.getAsync('firereset:license');
      const mac = await networkTool.getIdentifierMAC();
      const lic = await bone.getLicenseAsync(luid, mac);
      log.debug('[license]', lic);
      await license.writeLicenseAsync(lic);
    });

    it('should checkin', async() => {
      let bone = require("../lib/Bone.js");

      let sysInfo = await sysManager.getSysInfoAsync()
      const result = await bone.checkinAsync(fc.version, license.getLicense(), sysInfo)
      log.debug('checkin result', result);
    });
  })

  describe('.intel', function () {
    before((done) => {
      (async() =>{
        done();
      })();
    })

    it('should load intel correctly (netflix)', async() => {
      let sampleData = {flowlist:intelSample.netflix, hashed: 1};
      let bone = require("../lib/Bone.js");

      let intelResult = await bone.intelAsync("*", "check", sampleData);
      log.debug('intelAsync check netflix', intelResult);
      let intel = intelResult[0];
      expect(intel.c).to.equal('av');
    })

    it('should load intel correctly (pinterest)',  async() => {
      let sampleData = {flowlist:intelSample.pinterest, hashed: 1};
      let bone = require("../lib/Bone.js");

      let intelResult = await bone.intelAsync("*", "check", sampleData);
      log.debug('intelAsync check pinterest', intelResult);
      let intel = intelResult[0];
      expect(intel.c).to.equal('ad');
    });

    it('should return xx if there is no intel about the ip address', async() => {
      let sampleData = {flowlist:intelSample.unknown, hashed: 1};
      let bone = require("../lib/Bone.js");

      try{
        let intelResult = await bone.intelAsync("*", "check", sampleData);
        log.debug('intelAsync check unknown', intelResult);
      } catch(err) {log.debug('intelAsync check unknown', err.message);}
    });
  })

  describe('.hashset', function () {
    it('should get hashsetAsync', async() => {
      let bone = require("../lib/Bone.js");
      expect(await bone.hashsetAsync(`bf:app.porn_bf`)).to.be.not.empty;
      expect(await bone.hashsetAsync(`metadata:bf:app.porn_bf`)).to.be.not.empty;
    });
  });
});
