/*    Copyright 2026 Firewalla Inc.
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
'use strict';

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire').noCallThru();

const logger = () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} });

// Exception.js only needs Alarm.js for alarm matching, which these tests do not exercise
const Exception = proxyquire('../alarm/Exception.js', {
  '../net2/logger.js': logger,
  './Alarm.js': class {},
});

describe('Exception number keys', () => {
  // what the app sends for a scheduled mute
  const created = () => new Exception({
    type: 'ALARM_VIDEO', 'p.device.mac': 'AA:BB:CC:DD:EE:FF',
    cronTime: '0 22 * * *', duration: 3600, timestamp: 1760000000,
  });
  // the same exception read back from redis, where every hash value is a string
  const loaded = () => new Exception({
    type: 'ALARM_VIDEO', 'p.device.mac': 'AA:BB:CC:DD:EE:FF',
    cronTime: '0 22 * * *', duration: '3600', timestamp: '1760000000',
  });

  it('normalizes duration to a number', () => {
    expect(loaded().duration).to.equal(3600);
  });

  it('matches a new scheduled exception against the stored copy', () => {
    expect(created().isEqualToException(loaded())).to.equal(true);
    expect(loaded().isEqualToException(created())).to.equal(true);
  });

  it('still tells different durations apart', () => {
    const other = loaded();
    other.duration = 7200;
    expect(created().isEqualToException(other)).to.equal(false);
  });
});
