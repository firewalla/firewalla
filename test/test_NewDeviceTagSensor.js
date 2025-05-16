/*    Copyright 2016-2025 Firewalla Inc.
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

const assert = require('chai').assert;
const NewDeviceTagSensor = require("../sensor/NewDeviceTagSensor.js");


describe('test NewDeviceTagSensor class', async () => {

  it('isFirewallaAP should return true when called with host MAC start with 20:6D:31:61', async() => {
    const hostObj = {
      o: {
        mac: "20:6D:31:61:00:00",
        dhcpName: "test"
      }
    };
    NewDeviceTagSensor.isFirewallaAP(hostObj).then((result) => {
      assert.equal(result, true);
    });
  });

  it('isFirewallaAP should return true when called with host MAC start with 20:6D:31:71', async() => {
    const hostObj = {
      o: {
        mac: "20:6D:31:71:00:00",
        dhcpName: "test"
      }
    };
    NewDeviceTagSensor.isFirewallaAP(hostObj).then((result) => {
      assert.equal(result, true);
    });
  });

  it('isFirewallaAP should return true when called with host MAC start with 20:6D:31 and dhcpName FirewallaAP', async() => {
    const hostObj = {
      o: {
        mac: "20:6D:31:71:00:00",
        dhcpName: "FirewallaAP"
      }
    };
    NewDeviceTagSensor.isFirewallaAP(hostObj).then((result) => {
      assert.equal(result, true);
    });
  });

  it('isFirewallaAP should return true when called with host MAC start with 20:6D:31 and dhcpLeaseName FirewallaAP', async() => {
    const hostObj = {
      o: {
        mac: "20:6D:31:71:00:00",
        "dnsmasq.dhcp.leaseName": "FirewallaAP"
      }
    };
    NewDeviceTagSensor.isFirewallaAP(hostObj).then((result) => {
      assert.equal(result, true);
    });
  });

  it('isFirewallaAP should return false when called with host MAC start with 20:6D:33 and dhcpLeaseName FirewallaAP', async() => {
    const hostObj = {
      o: {
        mac: "20:6D:31:71:00:00",
        "dnsmasq.dhcp.leaseName": "FirewallaAP"
      }
    };
    NewDeviceTagSensor.isFirewallaAP(hostObj).then((result) => {
      assert.equal(result, false);
    });
  });

  it('isFirewallaAP should return false when called with host MAC start with 20:6D:33 and dhcpName FirewallaAP', async() => {
    const hostObj = {
      o: {
        mac: "20:6D:31:71:00:00",
        "dhcpName": "FirewallaAP"
      }
    };
    NewDeviceTagSensor.isFirewallaAP(hostObj).then((result) => {
      assert.equal(result, false);
    });
  });

});