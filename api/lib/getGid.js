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
const jsonfile = require('jsonfile');
const _ = require('lodash');

const EncipherTool = require('../../net2/EncipherTool.js');
const encipherTool = new EncipherTool();

const UI_CONF_PATH = '/home/pi/.firewalla/ui.conf';
const readFileAsync = util.promisify(jsonfile.readFile);
const writeFileAsync = util.promisify(jsonfile.writeFile);

// Resolve the box gid for local (no-gid-in-request) API calls.
async function getGid() {
  try {
    const conf = await readFileAsync(UI_CONF_PATH);
    const gid = _.get(conf, 'gid');
    if (gid)
      return gid;
    log.warn('ui.conf has no gid, falling back to redis sys:ept');
  } catch (err) {
    log.warn(`ui.conf unreadable (${_.get(err, 'code') || err.message}), falling back to redis sys:ept`);
  }

  const gid = await encipherTool.getGID();
  if (!gid)
    throw new Error('gid not found in ui.conf or redis sys:ept');

  // self-heal
  try {
    await writeFileAsync(UI_CONF_PATH, { gid });
    log.info('Regenerated ui.conf from redis sys:ept');
  } catch (err) {
    log.error('Failed to regenerate ui.conf:', err.message);
  }
  return gid;
}

module.exports = getGid;
