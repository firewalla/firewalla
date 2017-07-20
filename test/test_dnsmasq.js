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

let Bootstrap = require('../net2/Bootstrap');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let DNSMASQSensor = require('../sensor/DNSMASQSensor');
let s = new DNSMASQSensor();

function delay(t) {
  return new Promise(function(resolve) {
    setTimeout(resolve, t)
  });
}

describe('Test dnsmasq feature', function() {
  this.timeout(20000);

  beforeEach((done) => {
    Bootstrap.bootstrap()
      .then(() => {
        sem.clearAllSubscriptions();
        s.registered = false;
        s.run()
          .then(() => {
            done();
          });
      }).catch((err) => {
      log.error("Failed to bootstrap Firwalla", err, {});
    });
  });

  afterEach((done) => {
    s._stop()
      .then(() => {
        done();
      });
  });

  it('should reload correctly even multiple reload requests arrive at the same time', (done) => {
    sem.emitEvent({
      type: 'ReloadDNSRule'
    });
    sem.emitEvent({
      type: 'ReloadDNSRule'
    });
    sem.emitEvent({
      type: 'ReloadDNSRule'
    });
    sem.emitEvent({
      type: 'ReloadDNSRule'
    });
    
    delay(5000)
      .then(() => {
        cp.exec("ps aux | grep dnsmasq", (err) => {
          expect(err).to.be.null;
          done();
        })
      })
  });

});