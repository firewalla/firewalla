/*    Copyright 2016-2026 Firewalla Inc.
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

const log = require('../../net2/logger.js')(__filename);
const util = require('util');
const fs = require('fs');
const jsonfile = require('jsonfile');

const EncipherTool = require('../../net2/EncipherTool.js');
const encipherTool = new EncipherTool();

// ui.conf is a local cache of the gid; redis sys:ept is the canonical source.
const UI_CONF_PATH = '/home/pi/.firewalla/ui.conf';
const readFileAsync = util.promisify(jsonfile.readFile);

let cachedGid = null;

// Atomic write: temp file + fsync + rename, so a mid-write crash can't leave a truncated ui.conf.
async function writeUiConfAtomic(gid) {
  const tmp = `${UI_CONF_PATH}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify({ gid }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, UI_CONF_PATH);
}

// Resolve the box gid for local (no-gid-in-request) API calls.
// gid only changes on factory-reset + re-pair, which reboots the box, so memoize once.
async function getGid() {
  if (cachedGid)
    return cachedGid;

  // fast path: read from the local cache
  const conf = await readFileAsync(UI_CONF_PATH).catch(() => null);
  if (conf && conf.gid)
    return (cachedGid = conf.gid);

  // fallback: read from the canonical redis source, then repair the local cache
  const gid = await encipherTool.getGID();
  if (!gid)
    throw new Error('gid not found in ui.conf or redis sys:ept');
  try {
    await writeUiConfAtomic(gid);
    log.info('Regenerated ui.conf from redis sys:ept');
  } catch (err) {
    log.error('Failed to regenerate ui.conf:', err.message);
  }
  return (cachedGid = gid);
}

module.exports = getGid;
