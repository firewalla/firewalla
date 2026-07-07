#!/usr/bin/env node
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

/*
 * Test tool for the netbot encryption API (FireAPI on :8833).
 *
 * Sends an encrypted request to POST /v1/encipher/message/<gid> and reports
 * whether the box's reply uses a per-request IV (the scheme added on top of
 * firecommit#8590 follow-up). Prints the decrypted reply.
 *
 * Usage (run on the box):
 *   node scripts/test_encipher_iv.js            # legacy mode: zero IV, no iv field
 *   node scripts/test_encipher_iv.js --iv       # new mode: random IV, sends iv field
 *   node scripts/test_encipher_iv.js --gid <gid>  # override group id
 *
 * Legacy mode works against any box. --iv mode requires a box that supports the
 * per-request IV change; an older box rejects it (HTTP 400/412) because it
 * decrypts with the zero IV.
 */

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const zlib = require('zlib');

const HOME = path.resolve(__dirname, '..');
const fcw = require(HOME + '/net2/FWCloudWrapper.js');
const EncipherTool = require(HOME + '/net2/EncipherTool.js');

const ALGO = 'aes-256-cbc';
const ZERO = Buffer.alloc(16);
const PORT = 8833;

const useIV = process.argv.includes('--iv');
const gidArgIdx = process.argv.indexOf('--gid');
const gidArg = gidArgIdx >= 0 ? process.argv[gidArgIdx + 1] : null;

function enc(text, key, iv) {
  const bkey = Buffer.from(key.substring(0, 32), 'utf8');
  const c = crypto.createCipheriv(ALGO, bkey, iv);
  return c.update(text, 'utf8', 'base64') + c.final('base64');
}
function dec(text, key, iv) {
  const bkey = Buffer.from(key.substring(0, 32), 'utf8');
  const d = crypto.createDecipheriv(ALGO, bkey, iv);
  return d.update(text, 'base64', 'utf8') + d.final('utf8');
}
// Response may be compressed (compressMode); best-effort inflate for display.
function maybeInflate(s) {
  try {
    const o = JSON.parse(s);
    if (o && o.data && (o.compressed || o.compressMode)) {
      const buf = Buffer.from(o.data, 'base64');
      for (const fn of [zlib.inflateSync, zlib.gunzipSync, zlib.inflateRawSync]) {
        try { return fn(buf).toString('utf8'); } catch (e) {}
      }
    }
  } catch (e) {}
  return s;
}

(async () => {
  await fcw.login();
  const cloud = fcw.getCloud();
  const gid = gidArg || await new EncipherTool().getGID();
  if (!gid) {
    console.error('No group id available (box not paired?). Pass --gid <gid>.');
    process.exit(1);
  }

  await cloud.groupFind(gid); // load group into cache so getKeyAsync returns the key
  const key = await cloud.getKeyAsync(gid, false);
  if (!key) {
    console.error('Could not obtain group key for gid', gid);
    process.exit(1);
  }

  const id = 'ivtest-' + Date.now();
  const plaintext = JSON.stringify({
    message: {
      mtype: 'msg', type: 'jsondata', from: 'iRocoX',
      obj: { mtype: 'get', id, data: { item: 'ping' }, type: 'jsonmsg', target: '0.0.0.0' },
      appInfo: { appID: 'com.rottiesoft.circle', version: '1.63', platform: 'test' }
    }
  });

  const reqIvBuf = useIV ? crypto.randomBytes(16) : ZERO;
  const body = { message: enc(plaintext, key, reqIvBuf) };
  if (useIV) body.iv = reqIvBuf.toString('base64');

  console.log('== REQUEST ==');
  console.log('mode        :', useIV ? 'NEW (random IV, iv field sent)' : 'LEGACY (zero IV, no iv field)');
  console.log('key (masked):', key.slice(0, 8) + '...(' + key.length + ' chars)');
  console.log('endpoint    : POST http://127.0.0.1:' + PORT + '/v1/encipher/message/' + gid);

  const payload = JSON.stringify(body);
  const res = await new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/encipher/message/' + gid, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve({ status: resp.statusCode, body: d })); });
    r.on('error', reject); r.write(payload); r.end();
  });

  console.log('== REPLY ==');
  console.log('HTTP status :', res.status);
  let reply; try { reply = JSON.parse(res.body); } catch (e) { reply = null; }
  if (!reply) { console.log('raw reply   :', res.body.slice(0, 300)); process.exit(0); }

  const replyHasIv = reply.iv != null;
  console.log('reply.iv    :', replyHasIv ? reply.iv : '(none)');
  console.log('>> IV USAGE : box is ' + (replyHasIv ? 'USING a per-request IV (new scheme)' : 'NOT using IV (legacy zero IV)'));

  if (reply.message) {
    const replyIv = replyHasIv ? Buffer.from(reply.iv, 'base64') : ZERO;
    let out; try { out = maybeInflate(dec(reply.message, key, replyIv)); } catch (e) { out = '<decrypt failed: ' + e.message + '>'; }
    console.log('== DECRYPTED REPLY (first 400 chars) ==');
    console.log(out.slice(0, 400));
  } else {
    console.log('reply (no message):', JSON.stringify(reply).slice(0, 300));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e && (e.stack || e)); process.exit(1); });
