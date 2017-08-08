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

let async = require('asyncawait/async');
let await = require('asyncawait/await');

let sem = require('../sensor/SensorEventManager.js').getInstance();

let sample = require('./sample_data');

let Promise = require('bluebird');

describe('Spoofing', () => {
  it.skip('[Manual] spoof new device should work', (done) => {
    // When a new device joined the network, firewalla should automatically arp spoofing this device
    //   - 'redis-cli smembers monitored_hosts' @ Firewalla should contain this new device's IP address
    //   -  'arp -a -n' @ user device side should show that gateway IP is bound to Firewalla's MAC address
  })

  it.skip('[Manual] When device is configured "not monitoring" @ App, spoof should stop automatically', (done) => {
    // When select NOT to monitor device on Firewalla App, firewalla should automatically stop the arp spoofing
    //   - 'redis-cli smembers monitored_hosts' should NOT contain this device's IP address
    //   - 'redis-cli smembers unmonitored_hosts' should contain this device's IP address
    //   -  'arp -a -n' @ the user device side should show that gateway IP is bound to the real gateway MAC address
  })
});
