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
const Module = require('module');
const path = require('path');
const proxyquire = require('proxyquire').noCallThru();

function makeGenericStub() {
  const target = function () {
    return makeGenericStub();
  };

  return new Proxy(target, {
    apply() {
      return makeGenericStub();
    },
    construct() {
      return makeGenericStub();
    },
    get(object, property) {
      if (property === 'then')
        return undefined;
      if (property === Symbol.toPrimitive)
        return () => 0;
      if (!(property in object))
        object[property] = makeGenericStub();
      return object[property];
    }
  });
}

describe('VPN profile deletion hardening', function () {
  let NetBot;
  let bot;
  let legacyProfileExists;
  let cleanupCalls;
  let activityMode;
  let fakeVPNClient;
  let fakeClientClass;
  let realVPNClient;
  let realVPNState;

  before(function () {
    legacyProfileExists = true;
    cleanupCalls = {
      deletePolicies: 0,
      destroyStoredProfile: 0,
      portforward: 0
    };
    activityMode = 'inactive';

    const installRealVPNClient = () => {
      const state = {
        execFileCalls: [],
        cachedState: null,
        execFileResponder: () => Promise.resolve({ stdout: '' })
      };
      const client = proxyquire('../extension/vpnclient/VPNClient.js', {
        '../../net2/Firewalla.js': { isMain: () => false },
        '../../util/redis_manager.js': {
          getSubscriptionClient: () => ({ on: () => {} }),
          rclient: {
            getAsync: () => Promise.resolve(state.cachedState)
          }
        },
        'child-process-promise': {
          exec: () => Promise.resolve(),
          execFile: (...args) => {
            state.execFileCalls.push(args);
            return state.execFileResponder(...args);
          }
        },
        './VPNClientEnforcer.js': {
          destroyRtId: () => Promise.resolve()
        }
      });
      return { client, state };
    };

    ({ client: realVPNClient, state: realVPNState } = installRealVPNClient());

    fakeClientClass = class FakeVPNClient {
      static async profileExists() {
        return legacyProfileExists;
      }

      static async destroyStoredProfile(profileId, beforeDestroy) {
        cleanupCalls.destroyStoredProfile++;
        if (beforeDestroy)
          await beforeDestroy();
      }

      async status() {
        return false;
      }
    };

    fakeVPNClient = {
      validateProfileId(profileId) {
        if (profileId === 'legacy-profile')
          throw new Error(`Invalid VPN profile ID: ${profileId}`);
      },

      getClass(type) {
        return type === 'openvpn' ? fakeClientClass : null;
      },

      async isProfileActive(profileId) {
        // For legacy IDs the real implementation is responsible for deriving the interface name.
        if (profileId === 'legacy-profile')
          return realVPNClient.isProfileActive(profileId);
        return activityMode === 'active' ? true : activityMode === 'indeterminate' ? null : false;
      }
    };

    class FakePM2 {
      async deleteVpnClientRelatedPolicies() {
        cleanupCalls.deletePolicies++;
      }
    }

    const fakeExtensionManager = {
      hasCmd() {
        return false;
      },
      cmd() {
        throw new Error('unexpected ExtensionManager.cmd call');
      }
    };

    const originalLoad = Module._load;
    const netbotPath = path.resolve(__dirname, '../controllers/netbot.js');

    Module._load = function (request, parent, isMain) {
      if (request === '../extension/vpnclient/VPNClient.js')
        return fakeVPNClient;
      if (request === '../alarm/PolicyManager2.js')
        return FakePM2;
      if (request === '../sensor/ExtensionManager.js')
        return fakeExtensionManager;
      if (Module.builtinModules.includes(request))
        return originalLoad.apply(this, arguments);
      return makeGenericStub();
    };

    try {
      delete require.cache[netbotPath];
      NetBot = require(netbotPath);
    } finally {
      Module._load = originalLoad;
    }

    bot = Object.create(NetBot.prototype);
    bot._portforward = async function () {
      cleanupCalls.portforward++;
    };
  });

  beforeEach(function () {
    legacyProfileExists = true;
    activityMode = 'inactive';
    realVPNState.cachedState = null;
    realVPNState.execFileCalls.length = 0;
    realVPNState.execFileResponder = () => Promise.resolve({ stdout: '' });
    cleanupCalls.deletePolicies = 0;
    cleanupCalls.destroyStoredProfile = 0;
    cleanupCalls.portforward = 0;
  });

  async function deleteLegacyProfile() {
    let error;
    try {
      await bot.cmdHandler('test-gid', {
        data: {
          item: 'deleteVpnProfile',
          value: {
            type: 'openvpn',
            profileId: 'legacy-profile'
          }
        }
      });
    } catch (err) {
      error = err;
    }
    return error;
  }

  it('successfully cleans up an existing inactive legacy profile through the integrated safety path', async function () {
    realVPNState.execFileResponder = (binary, args) => {
      expect(binary).to.equal('ip');
      expect(args).to.eql(['-o', 'link', 'show']);
      return Promise.resolve({ stdout: '1: lo: <LOOPBACK>\n2: eth0: <BROADCAST>\n' });
    };

    const error = await deleteLegacyProfile();

    expect(error).to.equal(undefined);
    expect(realVPNState.execFileCalls).to.have.lengthOf(1);
    expect(cleanupCalls.deletePolicies).to.equal(1);
    expect(cleanupCalls.destroyStoredProfile).to.equal(1);
    expect(cleanupCalls.portforward).to.equal(1);
  });

  it('refuses deletion of an active legacy profile without cleanup', async function () {
    realVPNState.execFileResponder = (binary, args) => {
      expect(binary).to.equal('ip');
      expect(args).to.eql(['-o', 'link', 'show']);
      return Promise.resolve({ stdout: '1: lo: <LOOPBACK>\n2: vpn_legacy-profile: <POINTOPOINT>\n' });
    };

    const error = await deleteLegacyProfile();

    expect(error).to.deep.include({ code: 400 });
    expect(error.msg).to.equal('Automated deletion is refused for active or indeterminate legacy openvpn VPN client legacy-profile');
    expect(cleanupCalls.deletePolicies).to.equal(0);
    expect(cleanupCalls.destroyStoredProfile).to.equal(0);
    expect(cleanupCalls.portforward).to.equal(0);
  });

  it('refuses deletion of a legacy profile with an indeterminate activity state', async function () {
    realVPNState.execFileResponder = () => Promise.reject(Object.assign(new Error('permission denied'), { code: 2 }));

    const error = await deleteLegacyProfile();

    expect(error).to.deep.include({ code: 400 });
    expect(error.msg).to.equal('Automated deletion is refused for active or indeterminate legacy openvpn VPN client legacy-profile');
    expect(cleanupCalls.deletePolicies).to.equal(0);
    expect(cleanupCalls.destroyStoredProfile).to.equal(0);
    expect(cleanupCalls.portforward).to.equal(0);
  });

  it('preserves the original validation error when no stored legacy profile exists', async function () {
    legacyProfileExists = false;

    const error = await deleteLegacyProfile();

    expect(error).to.deep.include({
      code: 400,
      msg: 'Invalid VPN profile ID: legacy-profile'
    });
    expect(cleanupCalls.deletePolicies).to.equal(0);
    expect(cleanupCalls.destroyStoredProfile).to.equal(0);
    expect(cleanupCalls.portforward).to.equal(0);
  });
});
