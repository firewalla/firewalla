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
  let isProfileActiveCalls;
  let fakeVPNClient;
  let fakeClientClass;

  before(function () {
    legacyProfileExists = true;
    cleanupCalls = {
      deletePolicies: 0,
      destroyStoredProfile: 0,
      portforward: 0
    };
    isProfileActiveCalls = 0;

    fakeClientClass = class FakeVPNClient {
      static async profileExists() {
        return legacyProfileExists;
      }

      static async destroyStoredProfile() {
        cleanupCalls.destroyStoredProfile++;
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

      async isProfileActive() {
        isProfileActiveCalls++;
        return false;
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

  it('refuses deletion of an existing invalid legacy profile without cleanup', async function () {
    legacyProfileExists = true;

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

    expect(error).to.deep.include({ code: 400 });
    expect(error.msg).to.equal('Automated deletion is refused for legacy openvpn VPN client legacy-profile');
    expect(isProfileActiveCalls).to.equal(0);
    expect(cleanupCalls.deletePolicies).to.equal(0);
    expect(cleanupCalls.destroyStoredProfile).to.equal(0);
    expect(cleanupCalls.portforward).to.equal(0);
  });

  it('preserves the original validation error when no stored legacy profile exists', async function () {
    legacyProfileExists = false;

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

    expect(error).to.deep.include({
      code: 400,
      msg: 'Invalid VPN profile ID: legacy-profile'
    });
    expect(isProfileActiveCalls).to.equal(0);
    expect(cleanupCalls.deletePolicies).to.equal(0);
    expect(cleanupCalls.destroyStoredProfile).to.equal(0);
    expect(cleanupCalls.portforward).to.equal(0);
  });
});
