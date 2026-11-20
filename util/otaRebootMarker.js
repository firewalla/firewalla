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

// the build an OTA reboot is meant to boot into, written by OtaSensor and read by SystemRebootSensor
// a file, not redis: redis only saves to disk every few minutes and the reboot may be a power cut

const log = require('../net2/logger.js')(__filename);
const f = require('../net2/Firewalla.js');
const fsp = require('fs').promises;

const DIR = f.getHiddenFolder();
const FILE = `${DIR}/ota_reboot_pending.json`;
let tmpSeq = 0;

async function syncPath(path, flags) {
  const fh = await fsp.open(path, flags);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// write then rename, so a power cut leaves the old file or the new one, never a partial one
async function write(marker) {
  const tmp = `${FILE}.${process.pid}.${++tmpSeq}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(marker));
  await syncPath(tmp, 'r+');
  await fsp.rename(tmp, FILE);
  await syncPath(DIR, 'r');
}

// null when absent or unreadable, which callers treat as no OTA reboot
async function read() {
  try {
    const marker = JSON.parse(await fsp.readFile(FILE, 'utf8'));
    return marker && marker.build ? marker : null;
  } catch (err) {
    if (err.code !== 'ENOENT')
      log.warn(`Ignoring unreadable ${FILE}`, err.message);
    return null;
  }
}

async function remove() {
  await fsp.unlink(FILE).catch((err) => {
    if (err.code !== 'ENOENT')
      throw err;
  });
}

module.exports = { FILE, write, read, remove };
