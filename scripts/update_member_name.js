#!/usr/bin/env node
/*
 * Show the encrypted "name" (account email) for a group member entry.
 *
 * Given a member eid and a new cleartext email, print the AES-encrypted
 * value as it would be stored in symmetricKeys[].name in the Encipher
 * cloud. Read-only / offline: it reuses the box's own EptCloud crypto and
 * the group info cached in redis (sys:ept:me), never contacting the cloud.
 *
 * Run on the box, from the firewalla home:
 *   cd /home/pi/firewalla
 *   OPENSSL_CONF=/dev/null bin/node scripts/update_member_name.js <eid> "<new email>"
 */
'use strict';

const cloud = require('../encipher');

async function main() {
  const eid = process.argv[2];
  const newName = process.argv[3];

  if (!eid || !newName) {
    console.error('usage: node scripts/update_member_name.js <eid> "<new email>"');
    process.exit(1);
  }

  const eptcloud = new cloud('netbot');
  await eptcloud.loadKeys();
  await eptcloud.reloadGroupInfoFromRedis();

  const gid = Object.keys(eptcloud.groupCache)[0];
  const cached = gid && eptcloud.groupCache[gid];
  if (!cached) throw new Error('no group info cached in redis (sys:ept:me)');

  const symmetricKey = cached.key; // decrypted group symmetric key
  const entry = cached.group.symmetricKeys.find(k => k.eid === eid);
  if (!entry) {
    console.error(`eid ${eid} is not a member of group ${gid}. Members:`);
    for (const k of cached.group.symmetricKeys) console.error('  ' + k.eid);
    process.exit(1);
  }

  const oldName = entry.name ? eptcloud.decrypt(entry.name, symmetricKey) : '(none)';

  console.log('gid           :', gid);
  console.log('eid           :', eid);
  console.log('old name      :', oldName);
  console.log('new name      :', newName);
  console.log('new encrypted :', eptcloud.encrypt(newName, symmetricKey));
}

main().then(() => process.exit(0)).catch(err => {
  console.error('ERROR:', err && err.message ? err.message : err);
  process.exit(1);
});
