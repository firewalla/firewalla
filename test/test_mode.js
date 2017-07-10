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

let Mode = require('../net2/Mode.js');
let ModeManager = require('../net2/ModeManager');

let fs = require('fs');
let cp = require('child_process');

let cw = require("../net2/FWCloudWrapper");
 
let assert = chai.assert;

let SysManager = require('../net2/SysManager.js');
let sysManager = new SysManager();
let firewallaConfig = require('../net2/config.js').getConfig();
sysManager.setConfig(firewallaConfig);

let bone = require('../lib/Bone');

describe('Test mode feature', function() {
  this.timeout(10000);
  
  beforeEach((done) => {
    cw.login()
      .then(() => {
        bone.waitUtilCloudReady(() => {
          done();
        })
      }).catch((err) => {
      assert.fail()
    });
  });
  
  afterEach((done) => {
    cp.exec("sudo pkill bitbridge7", (err) => {
      done();
    })
  });
  
  it('should enable dhcp and disable spoofing when mode is switched to dhcp', (done) => {
    setTimeout(done, 10000);
    
    ModeManager.switchToDHCP()
      .then(() => {
        cp.exec("ps aux | grep dnsma[s]q | grep d[h]cp", (err) => {
          expect(err).to.be.null;

          cp.exec("ps aux | grep bi[t]bridge7", (err, stdout) => {
            console.log(stdout);
            expect(err).to.not.null;
            done()
          })
        })
      })
  });
  
  it('should enable spoofing and disable dhcp when mode is switched to spoofing', (done) => {
    setTimeout(done, 10000);

    ModeManager.switchToSpoof()
      .then(() => {
        cp.exec("ps aux | grep dnsma[s]q | grep d[h]cp", (err, stdout, stderr) => {
          expect(err).to.not.null;

          cp.exec("ps aux | grep bi[t]bridge7", (err) => {
            expect(err).to.be.null;
            done()
          })
        })
      })
  });
});