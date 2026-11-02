/*    Copyright 2026 Firewalla INC
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

const log = require("../net2/logger.js")(__filename);

const rclient = require('./redis_manager.js').getRedisClient();

const LOCK_KEY = "lock:sys:ept:gid";
const LOCK_TTL_SEC = 120;
const RETRY_INTERVAL_MS = 1000;
const MAX_ATTEMPTS = 150;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readGid(storage) {
  let gid = null;
  try {
    gid = storage.getItemSync('groupId');
  } catch (err) {
    log.warn("Failed to read groupId from node-persist:", err.message);
  }
  if (!gid)
    gid = await rclient.hgetAsync("sys:ept", "gid").catch((err) => {
      log.warn("Failed to read sys:ept.gid:", err.message);
      return null;
    });
  return gid || null;
}

async function recordGid(storage, gid) {
  try {
    storage.setItemSync('groupId', gid);
  } catch (err) {
    log.error("Failed to persist groupId to node-persist:", err.message);
  }
  return gid;
}

async function createGroup(eptcloud, config, model) {
  const meta = JSON.stringify({
    'type': config.serviceType,
    'member': config.memberType,
    'model': model
  });
  log.info("Creating new group", config.service, config.endpoint_name, "as eid", eptcloud.eid);
  const gid = await eptcloud.eptCreateGroup(config.service, meta, config.endpoint_name);
  if (!gid)
    throw new Error("eptCreateGroup returned no gid");
  log.forceInfo("Created group", gid);
  return gid;
}

async function ensureGroup({ eptcloud, config, model, storage, maxAttempts = MAX_ATTEMPTS }) {
  for (let i = 0; i < maxAttempts; i++) {
    const existing = await readGid(storage);
    if (existing)
      return recordGid(storage, existing);

    const locked = await rclient.setAsync(LOCK_KEY, '1', 'NX', 'EX', LOCK_TTL_SEC);
    if (locked === 'OK') {
      try {
        const raced = await readGid(storage);
        return recordGid(storage, raced || await createGroup(eptcloud, config, model));
      } finally {
        await rclient.delAsync(LOCK_KEY).catch(() => {});
      }
    }

    log.info("Another process is creating the group, retrying");
    await sleep(RETRY_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for another process to create the group");
}

async function publishEpt(eptcloud, gid) {
  await rclient.hmsetAsync("sys:ept", {
    eid: eptcloud.eid,
    token: eptcloud.token,
    gid: gid
  });
}

module.exports = {
  ensureGroup,
  publishEpt
};
