/*    Copyright 2016-2026 Firewalla Inc.
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

const chai = require('chai');
const { assert, expect } = chai

const sample = require('./sample_data.js');
const Exception = require('../alarm/Exception.js');
const Alarm = require('../alarm/Alarm.js');
// const lm = require('../net2/LoggerManager.js');
// lm.setLogLevel('Exception', 'debug');

describe('Exception', function() {
  this.timeout(50000);

  before(() => {
    const ExcpetionManager = require('../alarm/ExceptionManager.js');
    const exceptionManager = new ExcpetionManager();
    exceptionManager.refreshCategoryMap()
  })

  describe('valueMatch', () => {
    const e = new Exception({})
    it('should match string value', () => {
      expect(e.valueMatch("test", "test")).to.be.true;
      expect(e.valueMatch("test", "TEST")).to.be.false;
      expect(e.valueMatch("test", "tes")).to.be.false;
      // glob matching only happen with string ends with "*" or starting with "*."
      expect(e.valueMatch("tes*", "test")).to.be.true;
      expect(e.valueMatch("*t*e", "test")).to.be.false;
    });

    it('should match domain and IP', () => {
      expect(e.valueMatch("*.test.com", "a.test.com")).to.be.true;
      expect(e.valueMatch("*.test.com", "test.com")).to.be.true;
      expect(e.valueMatch("*.test.com", "a.est.com")).to.be.false;
    });

    describe('CIDR match (IPv4)', () => {
      it('should match IPv4 address inside /24 subnet', () => {
        expect(e.valueMatch("1.1.1.0/24", "1.1.1.255")).to.be.true;
        expect(e.valueMatch("1.1.1.1/16", "1.1.255.255")).to.be.true;
        expect(e.valueMatch("192.168.1.0/24", "192.168.1.0")).to.be.true;
        expect(e.valueMatch("192.168.1.0/24", "192.168.1.1")).to.be.true;
        expect(e.valueMatch("192.168.1.0/24", "192.168.1.255")).to.be.true;
      });
      it('should not match IPv4 address outside subnet', () => {
        expect(e.valueMatch("1.1.1.2/16", "1.2.0.0")).to.be.false;
        expect(e.valueMatch("192.168.1.0/24", "192.168.2.0")).to.be.false;
        expect(e.valueMatch("192.168.1.0/24", "192.168.0.255")).to.be.false;
        expect(e.valueMatch("10.0.0.0/8", "11.0.0.1")).to.be.false;
      });
      it('should match IPv4 with /32 (single host)', () => {
        expect(e.valueMatch("203.0.113.50/32", "203.0.113.50")).to.be.true;
        expect(e.valueMatch("203.0.113.50/32", "203.0.113.51")).to.be.false;
      });
    });

    describe('CIDR match (IPv6)', () => {
      it('should match IPv6 address inside subnet', () => {
        expect(e.valueMatch("2001:db8::/32", "2001:db8::1")).to.be.true;
        expect(e.valueMatch("2001:db8::/32", "2001:db8:0:0:0:0:0:1")).to.be.true;
        expect(e.valueMatch("fd00::/8", "fd12:3456:789a::1")).to.be.true;
      });
      it('should not match IPv6 address outside subnet', () => {
        expect(e.valueMatch("2001:db8::/32", "2001:db9::1")).to.be.false;
        expect(e.valueMatch("2001:db8::/64", "2001:db8:0:1::1")).to.be.false;
        expect(e.valueMatch("fd00::/8", "fe80::1")).to.be.false;
      });
      it('should match IPv6 with /128 (single host)', () => {
        expect(e.valueMatch("2001:db8::1/128", "2001:db8::1")).to.be.true;
        expect(e.valueMatch("2001:db8::1/128", "2001:db8::2")).to.be.false;
      });
    });

    it('should match number value', () => {
      expect(e.valueMatch(123, 123)).to.be.true;
      expect(e.valueMatch(123, 124)).to.be.false;
      expect(e.valueMatch('123', 123)).to.be.true;
      expect(e.valueMatch('12.3', 12.3)).to.be.true;
      expect(e.valueMatch('0', 0)).to.be.true;
      const spValues = [0, undefined, null, NaN, ''];
      for (let i = 0; i < spValues.length; i++)
        for (let j = i + 1; j < spValues.length; j++)
          expect(e.valueMatch(spValues[i], spValues[j]), `${spValues[i]} equals ${spValues[j]}`).to.be.false;
    });

  })

  describe('Example 1', () => {

    before(async () => {
      await sample.createSampleException()
    })

    after(async () => {
      await sample.removeSampleException()
    })

    it('should prevent from alarming if covered by exception', async () => {
      try {
        await sample.createSampleVideoAlarm()
        assert.fail();
      } catch(err) {
        expect(err.toString()).to.equal("Error: alarm is covered by exceptions");
      }
    })
  });

  describe('Example 2', () => {

    before(async () => {
      await sample.createSampleException2()
    })

    after(async () => {
      await sample.removeSampleException()
    })

    it('should prvent from alarming if covered by exception2', async () => {
      try {
        await sample.createSampleGameAlarm()
        assert.fail();
      } catch(err) {
        expect(err.toString()).to.equal("Error: alarm is covered by exceptions");
      }
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
        message: "This device visited game website battle.net."
      });

      expect(e1.match(a1)).to.be.true
      done();
    })

  });

});

