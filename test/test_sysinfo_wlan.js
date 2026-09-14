/*    Copyright 2016-2026 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
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

const {expect} = require('chai');
const proxyquire = require('proxyquire');

function loadSysInfo() {
  let interfaces = ['wlan0'];
  let redisAvailable = true;
  let kernelReload = 'enabled';

  const sysInfo = proxyquire('../extension/sysinfo/SysInfo.js', {
    'child-process-promise': {
      exec: async (cmd) => {
        if (cmd === 'iwconfig wlan0 | grep Quality') {
          return {
            stdout: 'Link Quality=80/100  Signal level=53/100  Noise level=0/100\n',
            stderr: '',
          };
        }

        throw new Error(`Unexpected command: ${cmd}`);
      },
    },
    '../../platform/PlatformLoader.js': {
      getPlatform: () => ({
        getAllNicNames: () => interfaces,
      }),
    },
    '../../util/redis_manager.js': {
      getRedisClient: () => ({
        getAsync: async (key) => {
          if (key === 'sys:wlan:kernelReload') {
            if (!redisAvailable)
              throw new Error('Redis unavailable');
            return kernelReload;
          }
          throw new Error(`Unexpected Redis key: ${key}`);
        },
      }),
    },
  });

  return {
    sysInfo,
    setInterfaces: (nextInterfaces) => {
      interfaces = nextInterfaces;
    },
    setRedisAvailable: (available) => {
      redisAvailable = available;
    },
  };
}

describe('SysInfo.getWlanInfo', function () {
  it('should not retain WLAN interfaces that disappear between refreshes', async function () {
    const {sysInfo, setInterfaces} = loadSysInfo();

    const firstInfo = await sysInfo.getWlanInfo();

    expect(firstInfo).to.have.property('wlan0');
    expect(firstInfo.wlan0).to.deep.equal({
      quality: '80',
      signal: '53',
      noise: '0',
    });

    setInterfaces([]);

    const secondInfo = await sysInfo.getWlanInfo();

    expect(secondInfo).to.not.have.property('wlan0');
    expect(secondInfo).to.have.property('kernelReload');
  });

  it('should publish a fresh WLAN snapshot when Redis is unavailable', async function () {
    const {sysInfo, setInterfaces, setRedisAvailable} = loadSysInfo();

    const firstInfo = await sysInfo.getWlanInfo();

    expect(firstInfo).to.have.property('wlan0');

    setInterfaces([]);
    setRedisAvailable(false);

    const secondInfo = await sysInfo.getWlanInfo();

    expect(secondInfo).to.not.have.property('wlan0');
    expect(secondInfo).to.have.property('kernelReload', firstInfo.kernelReload);
  });
});
