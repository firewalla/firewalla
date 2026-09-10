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
const applianceStubs = require('./helpers/vpnclient_appliance_stubs.js');

function loadVPNClient() {
  return proxyquire('../extension/vpnclient/VPNClient.js', {
    ...applianceStubs(),
    '../../net2/Firewalla.js': { isMain: () => false },
    '../../util/redis_manager.js': {
      getSubscriptionClient: () => ({ on() {}, subscribe() {} }),
      rclient: {
        getAsync: async () => null,
        setAsync: async () => {},
        expireAsync: async () => {},
        unlinkAsync: async () => {},
        delAsync: async () => {}
      }
    },
    'child-process-promise': {
      exec: async () => ({ stdout: '' }),
      execFile: async () => ({ stdout: '' })
    },
    './VPNClientEnforcer.js': {}
  });
}

function settleWithin(promise, timeoutMs) {
  return Promise.race([
    promise.then(value => ({ settled: true, value })),
    new Promise(resolve => setTimeout(() => resolve({ settled: false }), timeoutMs))
  ]);
}

describe('VPNClient protocol startup cancellation', function () {
  it('allows stop to complete while protocol _start remains pending', async function () {
    this.timeout(3000);
    const VPNClient = loadVPNClient();
    const client = Object.create(VPNClient.prototype);
    client.profileId = 'start_wait';
    client.isFirstLaunch = true;
    client._prepareRoutes = async () => {};
    client.flushRemoteEndpointRoutes = async () => {};
    client._isLinkUp = async () => false;

    let releaseProtocolStart;
    let protocolStartEntered;
    const entered = new Promise(resolve => { protocolStartEntered = resolve; });
    client._start = async () => {
      protocolStartEntered();
      await new Promise(resolve => { releaseProtocolStart = resolve; });
    };

    let stopCalls = 0;
    client._stopWithoutLifecycleLock = async () => {
      stopCalls++;
      client._started = false;
    };

    let staleStopCalls = 0;
    let staleStopCompleted;
    const staleStopped = new Promise(resolve => { staleStopCompleted = resolve; });
    client._stop = async () => {
      staleStopCalls++;
      staleStopCompleted();
    };

    const startPromise = client.start();
    try {
      await entered;

      const stopResult = await settleWithin(client.stop(), 500);
      expect(stopResult.settled).to.equal(true);
      expect(stopCalls).to.equal(1);

      const startResult = await settleWithin(startPromise, 500);
      expect(startResult).to.eql({
        settled: true,
        value: { result: false, cancelled: true }
      });
      expect(staleStopCalls).to.equal(0);

      releaseProtocolStart();
      const staleCleanup = await settleWithin(staleStopped, 500);
      expect(staleCleanup.settled).to.equal(true);
      expect(staleStopCalls).to.equal(1);
      expect(client._startupOperation).to.equal(null);
    } finally {
      if (releaseProtocolStart)
        releaseProtocolStart();
      if (client._cancelStartup)
        client._cancelStartup();
      client._cancelEstablishment();
      await startPromise.catch(() => {});
    }
  });
});
