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
const { matchesEmmcDevice, isVerifiedFirewallaProfile, getUpperDir } = dockerEmmcUsage;
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

describe('dockerEmmcUsage.getUpperDir', () => {
  it('should return the writable layer path for an overlay2 container', () => {
    const inspectObj = { GraphDriver: { Name: 'overlay2', Data: { UpperDir: '/var/lib/docker/overlay2/abc/diff' } } };
    expect(getUpperDir(inspectObj)).to.equal('/var/lib/docker/overlay2/abc/diff');
  });

  it('should return the writable layer path for the legacy overlay driver', () => {
    const inspectObj = { GraphDriver: { Name: 'overlay', Data: { UpperDir: '/var/lib/docker/overlay/abc/upper' } } };
    expect(getUpperDir(inspectObj)).to.equal('/var/lib/docker/overlay/abc/upper');
  });

  it('should return null for an unsupported storage driver', () => {
    const inspectObj = { GraphDriver: { Name: 'devicemapper', Data: { UpperDir: '/some/path' } } };
    expect(getUpperDir(inspectObj)).to.be.null;
  });

  it('should return null when GraphDriver or UpperDir is missing', () => {
    expect(getUpperDir({ GraphDriver: { Name: 'overlay2', Data: {} } })).to.be.null;
    expect(getUpperDir({ GraphDriver: { Name: 'overlay2' } })).to.be.null;
    expect(getUpperDir({ GraphDriver: null })).to.be.null; // docker 29 / overlayfs
    expect(getUpperDir({})).to.be.null;
  });
});

describe('dockerEmmcUsage.getEmmcUsage', () => {
  // findmnt/readlink/docker-info are the only shell calls getEmmcUsage makes directly;
  // deviceByPath stands in for the host mount table
  function makeExecFile(dockerRootDir, deviceByPath) {
    return async (cmd, args) => {
      if (cmd === 'readlink') return { stdout: `${args[1]}\n` };
      if (cmd !== 'sudo') throw new Error(`unexpected command: ${cmd}`);
      if (args[0] === 'systemctl') return { stdout: '' };
      if (args[0] === 'docker' && args[1] === 'info') return { stdout: `${dockerRootDir}\n` };
      if (args[0] === 'findmnt') {
        const source = deviceByPath[args[args.length - 1]];
        if (!source) throw new Error('findmnt: no such mount');
        return { stdout: JSON.stringify({ filesystems: [{ source, fstype: 'ext4', options: 'rw,relatime' }] }) };
      }
      throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
    };
  }

  function loadWithStubs(dockerRootDir, deviceByPath, inspectObjs) {
    return proxyquire('../extension/docker/dockerEmmcUsage.js', {
      'child-process-promise': { execFile: makeExecFile(dockerRootDir, deviceByPath), '@noCallThru': true },
      './docker.js': {
        listContainers: async () => inspectObjs.map((o, i) => ({ ID: `container${i}` })),
        inspectContainer: async (id) => [inspectObjs[Number(id.replace('container', ''))]],
        '@noCallThru': true,
      },
      '../../platform/PlatformLoader.js': {
        getPlatform: () => ({ isDockerSupported: () => true }),
        '@noCallThru': true,
      },
      '../vpnclient/VPNClient.js': {
        getClass: (type) => { throw new Error(`Unrecognized VPN client type: ${type}`); },
        '@noCallThru': true,
      },
    });
  }

  const EMMC_ROOT = { '/var/lib/docker': '/dev/mmcblk0p9' };

  it('should report a no-mount container on docker 29 / overlayfs, where inspect has no GraphDriver', async () => {
    const mod = loadWithStubs('/var/lib/docker', EMMC_ROOT, [
      { Name: '/user-app', Config: { Image: 'nginx:latest', Labels: {} }, Mounts: [], Driver: 'overlayfs' },
    ]);
    expect(await mod.getEmmcUsage()).to.deep.equal([
      { name: 'user-app', image: 'nginx:latest', mounts: [] },
    ]);
  });

  it('should still trust UpperDir over the data-root fallback when it points off eMMC', async () => {
    const upperDir = '/var/lib/docker/overlay2/abc/diff';
    const deviceByPath = Object.assign({}, EMMC_ROOT, { [upperDir]: '/dev/sda1' });
    const mod = loadWithStubs('/var/lib/docker', deviceByPath, [
      {
        Name: '/user-app',
        Config: { Image: 'nginx:latest', Labels: {} },
        Mounts: [],
        GraphDriver: { Name: 'overlay2', Data: { UpperDir: upperDir } },
      },
    ]);
    expect(await mod.getEmmcUsage()).to.deep.equal([]);
  });

  it('should keep skipping verified firewalla profiles, which the data-root fallback would otherwise catch', async () => {
    const mod = loadWithStubs('/var/lib/docker', EMMC_ROOT, [
      {
        Name: '/freeradius_freeradius_1',
        Config: {
          Image: 'freeradius:latest',
          Labels: { 'com.docker.compose.project.working_dir': `${f.getHiddenFolder()}/run/docker/freeradius` },
        },
        Mounts: [],
      },
    ]);
    expect(await mod.getEmmcUsage()).to.deep.equal([]);
  });
});
