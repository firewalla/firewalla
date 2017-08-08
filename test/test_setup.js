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

describe('Setup Process', () => {
  it.skip('[Manual] should successfully boot up', (done) => {
    // After setup, it should successfully boot up
    //
    // Should be able to successfully login with ssh (ssh password might change randomly, setup pub/priv key to login without password)
    //
    // With following process: (ssh pi@<firewalla_ip>)
    //   FireApi, FireMain, FireKick, FireMon, redis-server
    // With following port listening:
    //   FireApi - 0:0:0:0:8833, 127.0.0.1:8834 (for development branch, 127.0.0.1:8834 => 0.0.0.0:8834)
    //   redis-server - 127.0.0.1:6379
    // Santity test should pass
    //   bash /home/pi/firewalla/scripts/sanity_check
  })

  it.skip('[Manual] should bind app successfully', (done) => {
    // Firewalla Device and Firewalla App connect to same network
    //
    // After Firewalla Device boot up
    //   1. A new device will be displayed on app main interface
    //   2. Tap to bind
    //   3. Scan QR code from log file
    //       grep 'Or Scan this' /home/pi/.forever/kickui.log  -A 30
    //   4. App should successfuly bind to Device (show main interface for this new joined device)
  })

  it.skip('[Manual] Restore factory defaults should always work', (done) => {
    // Device should always be able to restore to factory Defaults
    // After Firewalla Device bound to App, App can use "Settings -> Reset to Factory Defaults" to restore to defaults
    //       - The binding between App and Device will be lost
    //       - Every new file created on device will be wiped out
    //       - Device will boot as a complete new device
  })

  it.skip('[Manual] **Hard** Restore Factory Defaults should always work', (done) => {
    // Device has another way to restore to factory defaults in case App can NOT be used for restoration
    // - Prepare a USB thumb drive, with one linux partition (ext3/ext4/fat32)
    // - Touch file 'firewalla_reset'under root folder
    // Plugin the USB thumb drive to Firewalla Device, reboot device
    //
    // Device should be able to successfully recognize the file on the USB thumb drive, and restore device to factory defaults successfully.
    //       - The binding between App and Device will be lost
    //       - Every new file created on device will be wiped out
    //       - Device will boot as a complete new device
  })

  it.skip('[Manual] Reboot device should work', (done) => {
    // After rebooting device, App should still be able to connect to device and load data
  })

  it.skip('[Manual] Unplug ethernet cable, device should reboot', (done) => {
    // As a protection (in case device brings the entire network down),
    // device will automatically reboot in 10 seconds if network gateway is not reachable any more
  })

  it.skip('[Manual] If ethernet cable is NOT plugged in, firewalla processes should NEVER start up', (done) => {
    // Firewalla Processes: FireApi, FireMain, FireKick, FireMon
    // After plug in the ethernet cable, these processes should start automatically in 60 seconds
    //
    // BTW: This test case can't be easily tested without debug serial cable
  })

  it.skip('[Manual] Unplug and plug in ethernet cable immediately, device should continue working as usual', (done) => {

  })

  it.skip('[Manual] Unplug and plug in power cable (micro-usb), device should reboot and work as usual after boot up', (done) => {

  })

});
