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

const { execFile } = require('child-process-promise');
const log = require('../../net2/logger.js')(__filename);
const f = require('../../net2/Firewalla.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();
const docker = require('./docker.js');

const FIREWALLA_DOCKER_DIR_PREFIX = `${f.getHiddenFolder()}/run/docker/`;

// docker-backed vpn client types from VPNClient.getClass() -- keep in sync manually
const DOCKER_VPN_CLIENT_TYPES = ['ssl', 'zerotier', 'trojan', 'nebula', 'ipsec', 'clash', 'hysteria', 'gost', 'ts'];

async function getKnownFirewallaProfileIds() {
  const VPNClient = require('../vpnclient/VPNClient.js');
  // fixed profile ids: freeradius (extension/freeradius/freeradius.js), clash (system-wide proxy in extension/clash_tun/clash_tun.js,
  // distinct from the per-profile 'clash' VPN client type below)
  const profileIds = new Set(['freeradius', 'clash']);
  await Promise.all(DOCKER_VPN_CLIENT_TYPES.map(async (type) => {
    try {
      const c = VPNClient.getClass(type);
      (await c.listProfileIds()).forEach(id => profileIds.add(id));
    } catch (err) {
      log.debug(`Failed to list profile ids for vpn client type ${type}`, err.message);
    }
  }));
  return profileIds;
}

function isVerifiedFirewallaProfile(inspectObj, knownProfileIds) {
  const workingDir = inspectObj.Config && inspectObj.Config.Labels &&
    inspectObj.Config.Labels['com.docker.compose.project.working_dir'];
  if (!workingDir || !workingDir.startsWith(FIREWALLA_DOCKER_DIR_PREFIX)) return false;

  const profileId = workingDir.slice(FIREWALLA_DOCKER_DIR_PREFIX.length).split('/')[0];
  return knownProfileIds.has(profileId);
}

// compares the mmcblkN family, ignoring partition suffix, e.g. /dev/mmcblk0p9 vs /dev/mmcblk0
function matchesEmmcDevice(deviceStr, emmcDeviceStr) {
  if (!deviceStr || !emmcDeviceStr) return false;
  const a = deviceStr.match(/mmcblk\d+/);
  const b = emmcDeviceStr.match(/mmcblk\d+/);
  return !!a && !!b && a[0] === b[0];
}

// Firewalla boxes mount / (and often /home) as an overlayfs, so a plain lookup on a real
// path just reports the pseudo filesystem "overlay", never the backing device.
// Walk through the overlay's upperdir (where writes actually land) until a
// real block device shows up.
async function resolveRealDevice(path, depth = 0) {
  if (depth > 5) return null;
  try {
    // sudo since volumes/binds may be owned by root or only traversable by root
    const result = await execFile('sudo', ['findmnt', '--json', '--output', 'source,fstype,options', '-T', path]);
    const filesystems = JSON.parse(result.stdout).filesystems;
    const fs = filesystems[filesystems.length - 1]; // most specific mount for this path
    if (!fs) return null;

    if (fs.fstype !== 'overlay') {
      // source may be a /dev/disk/by-label/* (or by-uuid/by-partuuid) symlink instead of
      // the raw device node; canonicalize so device-family comparisons are consistent
      return await execFile('readlink', ['-f', fs.source]).then(r => r.stdout.trim()).catch(() => fs.source);
    }

    const upperMatch = fs.options && fs.options.match(/upperdir=([^,]+)/);
    if (!upperMatch) return fs.source;

    return resolveRealDevice(upperMatch[1], depth + 1);
  } catch (err) {
    log.debug(`Failed to resolve real device for ${path}`, err.message);
    return null;
  }
}

async function getEmmcUsage() {
  if (!platform.isDockerSupported()) return [];

  const active = await execFile('sudo', ['systemctl', '-q', 'is-active', 'docker']).then(() => true).catch(() => false);
  if (!active) return [];

  const rootDevice = await resolveRealDevice('/');
  if (!rootDevice || !/mmcblk/.test(rootDevice)) return []; // root storage isn't eMMC (e.g. SSD-based models), nothing to warn about
  const emmcDevice = rootDevice;

  const containers = await docker.listContainers();
  if (!Array.isArray(containers) || containers.length === 0) return [];

  const knownProfileIds = await getKnownFirewallaProfileIds();

  const result = [];
  for (const container of containers) {
    const id = container.ID || container.Names;
    if (!id) continue;

    const inspectArr = await docker.inspectContainer(id);
    const inspectObj = Array.isArray(inspectArr) ? inspectArr[0] : inspectArr;
    if (!inspectObj) continue;
    if (isVerifiedFirewallaProfile(inspectObj, knownProfileIds)) continue;

    const mounts = (inspectObj.Mounts || []).filter(m => m.Type !== 'tmpfs' && m.Source);
    const emmcMounts = [];
    for (const mount of mounts) {
      const device = await resolveRealDevice(mount.Source);
      if (matchesEmmcDevice(device, emmcDevice)) {
        emmcMounts.push({ source: mount.Source, destination: mount.Destination });
      }
    }

    if (emmcMounts.length > 0) {
      result.push({
        name: (inspectObj.Name || '').replace(/^\//, ''),
        image: inspectObj.Config && inspectObj.Config.Image,
        mounts: emmcMounts
      });
    }
  }

  return result;
}

module.exports = {
  isVerifiedFirewallaProfile,
  getKnownFirewallaProfileIds,
  matchesEmmcDevice,
  getEmmcUsage,
};
