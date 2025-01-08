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
let should = chai.should();
let assert = chai.assert;

let sample = require('./sample_data');

let AlarmManager2 = require('../alarm/AlarmManager2.js')
let alarmManager2 = new AlarmManager2();

let Exception = require('../alarm/Exception');
let Alarm = require('../alarm/Alarm');

describe.skip('Exception', () => {

  describe('Example 1', () => {

    beforeEach((done) => {
      sample.createSampleException()
        .then(() => done())
    });

    afterEach((done) => {
      sample.removeSampleException()
        .then(() => done())
    })

    it('should prevent from alarming if covered by exception', (done) => {
      sample.createSampleVideoAlarm()
        .then(() => {
          assert.fail();
        }).catch((err) => {
        err.toString().should.equal("Error: alarm is covered by exceptions");
        done();
      })
    })
  });

  describe('Example 2', () => {
    beforeEach((done) => {
      sample.createSampleException2()
        .then(() => done())
    });

    afterEach((done) => {
      sample.removeSampleException()
        .then(() => done())
    })

    it('should prvent from alarming if covered by exception2', (done) => {
      sample.createSampleGameAlarm()
        .then(() => {
          assert.fail();
        }).catch((err) => {
        err.toString().should.equal("Error: alarm is covered by exceptions");
        done();
      })
    })

    it('this exception should match this alarm candidate', (done) => {
      let e1 = new Exception({
        "i.type": "domain",
        "reason": "ALARM_GAME",
        "type": "ALARM_GAME",
        "timestamp": "1500913117.175",
        "p.dest.id": "battle.net",
        "p.dest.ip": "114.113.217.103/24",
        "target_name": "battle.net",
        "target_ip": "114.113.217.103",
      });

      let a1 = new Alarm.GameAlarm(new Date() / 1000, "10.0.1.199", "battle.net", {
        device: "MiMac",
        alarmTimestamp: "1500906094.763",
        timestamp: "1500906041.064573",
        notifType: "activity",
        "p.dest.ip": "114.113.217.103",
        "p.dest.name": "battle.net",
        "p.device.ip" : "10.0.1.199",
        "p.device.name": "MiMac",
        "p.device.id": "B8:09:8A:B9:4B:05",
        "p.dest.id": "battle.net",
        "p.device.macVendor": "Apple",
        "p.device.mac": "B8:09:8A:B9:4B:05",
        "p.dest.latitude": "31.0456",
        "p.dest.longitude": "121.3997",
        "p.dest.country": "CN",
        message: "This device visited game website battle.net."
      });

      e1.match(a1).should.be.true
      done();
    })

  });

});

