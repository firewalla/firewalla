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

let muk = require('muk');

let Promise = require('bluebird');
Promise.promisifyAll(fs);
Promise.promisify(muk);

let sem = require('../sensor/SensorEventManager.js').getInstance();

let gmt = require('../util/DeviceMgmtTool');

let Firewalla = require('../net2/Firewalla.js');

let rclient = require('../util/redis_manager').getRedisClient();

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

let tempDir = "/tmp/fw_dmt_tmp_dir";
let tempWorkDir = "/tmp/fw_dmt_tmp_work_dir";
let logDir = "/tmp/fw_tmp_log_dir";
let logDir1 = "/tmp/fw_tmp_log_dir/dir1";
let logDir2 = "/tmp/fw_tmp_log_dir/dir2";
let logFile1 = "/tmp/fw_tmp_log_dir/dir1/file1";
let logFile2 = "/tmp/fw_tmp_log_dir/dir2/file2";


describe.skip('Test device management tool class', function() {
  this.timeout(10000);

  beforeEach((done) => {
    (async() =>{

      await fs.mkdirAsync(tempDir)
      await fs.mkdirAsync(tempWorkDir)
      await fs.mkdirAsync(logDir)
      await fs.mkdirAsync(logDir1)
      await fs.mkdirAsync(logDir2)
      await fs.writeFileAsync(logFile1, "test")
      await fs.writeFileAsync(logFile2, "test")
      await rclient.setAsync("key.test", "test")
      process.env['FIREWALLA_UPPER_DIR'] = tempDir;
      process.env['FIREWALLA_UPPER_WORK_DIR'] = tempWorkDir;
      process.env['FIREWALLA_LOG_DIR'] = logDir;

      // avoid script to do real reboot
      process.env['FIREWALLA_REBOOT_NORMAL_SCRIPT'] = '/bin/true';
      muk(Firewalla, 'isOverlayFS', () => true);
      done();
    })();
  });

  afterEach((done) => {
    (async() =>{
      muk.restore();
      await fs.rmdirAsync(tempDir + ".bak")
      await fs.rmdirAsync(tempWorkDir + ".bak")
      await fs.rmdirAsync(logDir1)
      await fs.rmdirAsync(logDir2)
      await fs.rmdirAsync(logDir)
      done();
    })();
  });

  it('should rename upper dir and work dir, redis data, log data if restore function is called', (done) => {
    (async() =>{
      await gmt.resetDevice()
      try {
        await fs.statAsync(tempDir)
        assert.fail('temp dir should not exist');
      } catch (err) {
        expect(err).to.not.null;
        expect(err.code).to.equal('ENOENT');
      }
      try {
        await fs.statAsync(tempWorkDir)
        assert.fail('temp work dir should not exist');
      } catch (err) {
        expect(err).to.not.null;
        expect(err.code).to.equal('ENOENT');
      }
      try {
        await fs.statAsync(logFile1)
        assert.fail('log file 1 should not exist');
      } catch (err) {
        expect(err).to.not.null;
        expect(err.code).to.equal('ENOENT');
      }
      try {
        await fs.statAsync(logFile2)
        assert.fail('log file 2 should not exist');
      } catch (err) {
        expect(err).to.not.null;
        expect(err.code).to.equal('ENOENT');
      }
      try {
        await fs.statAsync(logDir1)
        await fs.statAsync(logDir2)
      } catch (err) {
        assert.fail('log dir1 and dir2 should exist');
      }
      try {
        let keys = await rclient.keysAsync("*")
        if(keys.length > 0)
          console.log(keys);
        expect(keys.length).to.equal(0); // all keys should be gone
      } catch (err) {
        assert.fail('should not cause error when querying redis');
      }

      done();
    })();
  });
});
