/*    Copyright 2016-2025 Firewalla Inc.
 *
 *    ;This program is free software: you can redistribute it and/or  modify
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



const mock = require('mock-require');
const { expect, assert } = require('chai');


mock('../net2/logger.js', () => ({
  info: () => {},
  warn: () => {},
  error: () => {}
}));

mock('../sensor/Sensor.js', {
  Sensor: class {}
});

mock('../sensor/SensorEventManager.js', {
  getInstance: () => ({
    on: () => {},
    emit: () => {}
  })
});

mock('../net2/MessageBus.js', class {
  constructor() {}
  subscribe() {}
  publish() {}
});

mock('../net2/config.js', { get: () => {} });
mock('../net2/HostManager.js', class {});
mock('../net2/SysManager.js', {});
mock('../net2/NetworkProfileManager.js', {});
mock('../alarm/Alarm.js', {});
mock('../alarm/AlarmManager2.js', class {});
mock('../alarm/PolicyManager2.js', class {
  constructor() {}
});
mock('../util/util.js', {
  getPreferredBName: () => '',
  delay: async () => {}
});
mock('lodash', require('lodash'));
// mock('../net2/Constants.js', {});
mock('../net2/TagManager.js', {});


const NewDeviceTagSensor = require('../sensor/NewDeviceTagSensor');


describe('NewDeviceTagSensor.isFirewallaAP', () => {
  const sensorInstance = new NewDeviceTagSensor({});

  after(() => {
    mock.stopAll()
  })

  it('should return true for Firewalla AP MAC address "20:6D:31:61"', () => {
    const host = {
      o: {
        mac: '20:6D:31:61:CC:CC',
        dhcpName: 'notfirewalla'
      }
    }
    const result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, true);
  });

  it('should return true for Firewalla Ceiling AP MAC address, perfix "20:6D:31:71" ', () => {
    const host = {
      o: {
        mac: '20:6D:31:71:CC:CC',
        dhcpName: 'notfirewalla'
      }
    }
    const result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, true);
  });

  it('should return false for non-Firewalla MAC address', () => {
    const host = {
      o: {
        mac: '00:11:22:33:44:55',
        dhcpName: 'notfirewalla'
      }
    }
    const result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, false);
  });

  it('should return ture for these APs whose MAC address is start with "20:6D:31" and dhcpName or dhcpLeaseName is FirewallaAP', () => {
    let host = {
      o: {
        mac: '20:6D:31:XX:XX:XX',
        dhcpName: 'FirewallaAP'
      }
    }
    let result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, true);
    host = {
      o: {
        mac: '20:6D:31:XX:XX:XX',
        dhcpLeaseName: 'notFirewallaAP',
        "dnsmasq.dhcp.leaseName": "FirewallaAP"
      }
    }
    result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, true);

  });

 it('should return false for these APs whose MAC address is start with "20:6D:31" and dhcpName or dhcpLeaseName is not FirewallaAP', () => {
    let host = {
      o: {
        mac: '20:6D:31:XX:XX:XX',
        dhcpName: 'notFirewallaAP'
      }
    }
    let result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, false);
    host = {
      o: {
        mac: '20:6D:31:XX:XX:XX',
        dhcpLeaseName: 'notFirewallaAP',
        "dnsmasq.dhcp.leaseName": "notFirewallaAP"
      }
    }
    result = sensorInstance.isFirewallaAP(host);
    assert.equal(result, false);

  });

});