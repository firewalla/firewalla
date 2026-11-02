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

const NetworkMonitorSensor = proxyquire('../sensor/NetworkMonitorSensor.js', {
  '../net2/logger.js': () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  './Sensor.js': { Sensor: class { constructor(config) { this.config = config; } } },
  'child-process-promise': { exec: async () => ({ stdout: '' }) },
  '../net2/Firewalla.js': {},
  '../net2/config.js': {},
  './ExtensionManager.js': {},
  '../util/redis_manager.js': { getRedisClient: () => ({}) },
  '../net2/SysManager.js': {},
  './SensorEventManager.js': { getInstance: () => ({ on: () => {}, emit: () => {} }) },
  '../net2/Message.js': {},
  '../event/EventRequestApi.js': {},
  '../alarm/Alarm.js': {},
  '../alarm/AlarmManager2.js': class {},
  // no network_monitor policy, so sampleOnce samples with the config it is given
  '../net2/HostManager.js': class { constructor() { this.policy = {}; } async loadPolicyAsync() {} },
});

describe('NetworkMonitorSensor.sampleOnce', () => {
  let sensor;
  let calls;

  beforeEach(() => {
    sensor = new NetworkMonitorSensor({});
    calls = [];
    sensor.samplePing = async (target, cfg, opts) => {
      calls.push(opts);
      return { status: 'OK', data: {} };
    };
  });

  it('does not carry intf or save_result into a later call that omits them', async () => {
    // what apiRun passes for a sampleOnce cmd with and then without intf/save_result
    await sensor.sampleOnce('ping', '1.1.1.1', {}, false, 'eth1');
    await sensor.sampleOnce('ping', '1.1.1.1', {}, undefined, undefined);

    expect(calls[0]).to.deep.equal({ manual: true, saveResult: false, intf: 'eth1' });
    expect(calls[1]).to.deep.equal({ manual: true, saveResult: true });
  });

  it('keeps the options of a call in flight when another call starts', async () => {
    let release;
    const gate = new Promise(resolve => release = resolve);
    sensor.samplePing = async (target, cfg, opts) => {
      calls.push(opts);
      if (calls.length === 1) await gate;
      return { status: 'OK', data: {} };
    };

    const first = sensor.sampleOnce('ping', '1.1.1.1', {}, false, 'eth1');
    while (calls.length < 1) await new Promise(resolve => setImmediate(resolve));
    await sensor.sampleOnce('ping', '1.1.1.1', {}, true, 'eth2');
    release();
    await first;

    expect(calls[0]).to.not.equal(calls[1]);
    expect(calls[0]).to.deep.equal({ manual: true, saveResult: false, intf: 'eth1' });
    expect(calls[1]).to.deep.equal({ manual: true, saveResult: true, intf: 'eth2' });
  });
});
