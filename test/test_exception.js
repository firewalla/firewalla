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
let expect = chai.expect;

let sample = require('./sample_data');

let AlarmManager2 = require('../alarm/AlarmManager2.js')

let Exception = require('../alarm/Exception');

const EM = require('../alarm/ExceptionManager.js');
let em = new EM();

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


describe('Test strip fields', function() {
  this.timeout(30000);
  it('should strip fields', async () => {
    let exceptions = [
      {"type":"ALARM_VPN_RESTORE","p.vpn.profileid":"6ACC_6ACCB","timestamp":1541173167.733,"eid":"10"},
      {"type":"ALARM_VPN_DISCONNECT","p.vpn.profileid":"6ACC_6ACCB","timestamp":1541173167.7,"eid":"9"},
      {"type":"ALARM_CUSTOMIZED_SECURITY","alarmTimestamp":1541173167,"alarm_type":"ALARM_CUSTOMIZED_SECURITY","aid":"234","if.type":"category","category":"","timestamp":1528548944.65,"p.device.mac":"00","p.category.id":"10f81a5e71cc","eid":"5","if.targetList":"true","matchCount":"1"},
      {"type":"ALARM_LARGE_UPLOAD","alarm_type":"ALARM_LARGE_UPLOAD","aid":"321","if.type":"dns","if.target":"firewalla.zendesk.com","category":"","timestamp":1527164701.257,"p.dest.name":"*.firewalla.com","target_name":"*.firewalla.com","target_ip":"1.2.3.4","p.device.mac":"00","eid":"1","matchCount":"33"}
    ];

    exceptions = exceptions.map((r) => em.stripRule(r));
    expect(exceptions[2].hasOwnProperty('alarmTimestamp')).to.be.false;
    expect(exceptions[2].hasOwnProperty('category')).to.be.false;
    expect(exceptions[3].hasOwnProperty('if.type')).to.be.false;

  });
});