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
'use strict'

const chai = require('chai');
const expect = chai.expect;
const proxyquire = require('proxyquire');

const dockerEmmcUsage = require('../extension/docker/dockerEmmcUsage.js');
const { matchesEmmcDevice, isVerifiedFirewallaProfile } = dockerEmmcUsage;
const f = require('../net2/Firewalla.js');

describe('dockerEmmcUsage.isVerifiedFirewallaProfile', () => {
  it('should verify a container whose profileId is in the known set', () => {
    const workingDir = `${f.getHiddenFolder()}/run/docker/freeradius`;
    const inspectObj = { Config: { Labels: { 'com.docker.compose.project.working_dir': workingDir } } };
    expect(isVerifiedFirewallaProfile(inspectObj, new Set(['freeradius']))).to.be.true;
  });

  it('should reject a spoofed label whose profileId is not in the known set', () => {
    const workingDir = `${f.getHiddenFolder()}/run/docker/not-a-real-profile`;
    const inspectObj = { Config: { Labels: { 'com.docker.compose.project.working_dir': workingDir } } };
    expect(isVerifiedFirewallaProfile(inspectObj, new Set(['freeradius']))).to.be.false;
  });

  it('should treat user containers without a matching working_dir as customized', () => {
    const inspectObj = { Config: { Labels: { 'com.docker.compose.project.working_dir': '/home/pi/my-app' } } };
    expect(isVerifiedFirewallaProfile(inspectObj, new Set(['freeradius']))).to.be.false;
  });

  it('should treat containers with no compose label at all as customized', () => {
    const knownProfileIds = new Set(['freeradius']);
    expect(isVerifiedFirewallaProfile({ Config: { Labels: {} } }, knownProfileIds)).to.be.false;
    expect(isVerifiedFirewallaProfile({ Config: {} }, knownProfileIds)).to.be.false;
    expect(isVerifiedFirewallaProfile({}, knownProfileIds)).to.be.false;
  });
});

describe('dockerEmmcUsage.getKnownFirewallaProfileIds', () => {
  function loadWithStubbedVPNClient(classesByType) {
    return proxyquire('../extension/docker/dockerEmmcUsage.js', {
      '../vpnclient/VPNClient.js': {
        getClass: (type) => {
          if (!classesByType[type]) throw new Error(`Unrecognized VPN client type: ${type}`);
          return classesByType[type];
        },
        '@noCallThru': true,
      },
    });
  }

  it('should always include the fixed freeradius and clash profile ids', async () => {
    const mod = loadWithStubbedVPNClient({});
    const ids = await mod.getKnownFirewallaProfileIds();
    expect(ids.has('freeradius')).to.be.true;
    expect(ids.has('clash')).to.be.true;
  });

  it('should union profile ids across all docker vpn client types', async () => {
    const mod = loadWithStubbedVPNClient({
      ssl: { listProfileIds: async () => ['ssl1'] },
      ipsec: { listProfileIds: async () => ['ipsec1', 'ipsec2'] },
    });
    const ids = await mod.getKnownFirewallaProfileIds();
    expect([...ids].sort()).to.deep.equal(['clash', 'freeradius', 'ipsec1', 'ipsec2', 'ssl1']);
  });

  it('should not let one protocol failing to list profiles break the others', async () => {
    const mod = loadWithStubbedVPNClient({
      ssl: { listProfileIds: async () => { throw new Error('boom'); } },
      clash: { listProfileIds: async () => ['clash1'] },
    });
    const ids = await mod.getKnownFirewallaProfileIds();
    expect([...ids].sort()).to.deep.equal(['clash', 'clash1', 'freeradius']);
  });
});

describe('dockerEmmcUsage.matchesEmmcDevice', () => {
  it('should match same device family ignoring partition suffix', () => {
    expect(matchesEmmcDevice('/dev/mmcblk0p9', '/dev/mmcblk0')).to.be.true;
    expect(matchesEmmcDevice('/dev/mmcblk0', '/dev/mmcblk0p1')).to.be.true;
  });

  it('should not match a different mmcblk device family', () => {
    expect(matchesEmmcDevice('/dev/mmcblk1p1', '/dev/mmcblk0')).to.be.false;
  });

  it('should not match non-eMMC devices, e.g. external/USB storage', () => {
    expect(matchesEmmcDevice('/dev/sda1', '/dev/mmcblk0')).to.be.false;
    expect(matchesEmmcDevice('overlay', '/dev/mmcblk0')).to.be.false;
  });

  it('should handle empty/undefined input safely', () => {
    expect(matchesEmmcDevice(null, '/dev/mmcblk0')).to.be.false;
    expect(matchesEmmcDevice('/dev/mmcblk0', null)).to.be.false;
    expect(matchesEmmcDevice('', '')).to.be.false;
  });
});
