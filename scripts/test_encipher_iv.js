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
 *   node scripts/test_encipher_iv.js              # legacy zero IV (bare base64)
 *   node scripts/test_encipher_iv.js --iv         # random-IV CBC ({ iv, message } envelope)
 *   node scripts/test_encipher_iv.js --gcm        # AES-256-GCM ({ alg, iv, message, tag }, AAD=gid)
 *   node scripts/test_encipher_iv.js --gid <gid>  # override group id
 *
 * The box mirrors the request scheme on its reply. --iv/--gcm against a box that
 * does not support them yields HTTP 400/412.
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

// Scheme: --gcm (authenticated), --iv (random-IV CBC), else legacy zero IV.
const useGCM = process.argv.includes('--gcm');
const useIV = process.argv.includes('--iv');
const gidArgIdx = process.argv.indexOf('--gid');
const gidArg = gidArgIdx >= 0 ? process.argv[gidArgIdx + 1] : null;

// Encrypt to the wire format. scheme: 'gcm' | 'cbc-iv' | 'legacy'. Mirrors encipher.
function enc(text, key, scheme, gid) {
  const bkey = Buffer.from(key.substring(0, 32), 'utf8');
  if (scheme === 'gcm') {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', bkey, nonce);
    c.setAAD(Buffer.from(gid, 'utf8'));
    const ct = c.update(text, 'utf8', 'base64') + c.final('base64');
    return JSON.stringify({ alg: 'gcm', iv: nonce.toString('base64'), message: ct, tag: c.getAuthTag().toString('base64') });
  }
  if (scheme === 'cbc-iv') {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv(ALGO, bkey, iv);
    const ct = c.update(text, 'utf8', 'base64') + c.final('base64');
    return JSON.stringify({ iv: iv.toString('base64'), message: ct });
  }
  const c = crypto.createCipheriv(ALGO, bkey, ZERO);
  return c.update(text, 'utf8', 'base64') + c.final('base64');
}
// Decrypt a wire value; iv/tag are embedded in the envelope. Returns { plaintext, scheme }.
function decEnvelope(text, key, gid) {
  const bkey = Buffer.from(key.substring(0, 32), 'utf8');
  let scheme = 'legacy', iv = ZERO, ct = text, tag = null, alg = null;
  try {
    const p = JSON.parse(text);
    if (typeof p === 'string') { ct = p; }
    else if (p && typeof p === 'object' && !Array.isArray(p) && p.message != null) {
      ct = p.message; alg = p.alg;
      if (p.iv != null) iv = Buffer.from(p.iv, 'base64');
      if (p.tag != null) tag = Buffer.from(p.tag, 'base64');
    }
  } catch (e) { /* raw base64, legacy */ }
  if (alg === 'gcm') {
    scheme = 'gcm';
    const d = crypto.createDecipheriv('aes-256-gcm', bkey, iv);
    d.setAAD(Buffer.from(gid, 'utf8'));
    d.setAuthTag(tag);
    return { plaintext: d.update(ct, 'base64', 'utf8') + d.final('utf8'), scheme };
  }
  if (iv !== ZERO) scheme = 'cbc-iv';
  const d = crypto.createDecipheriv(ALGO, bkey, iv);
  return { plaintext: d.update(ct, 'base64', 'utf8') + d.final('utf8'), scheme };
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
  const key = await cloud.getKeyAsync(gid, false); // current (possibly rotated) message key
  if (!key) {
    console.error('Could not obtain group key for gid', gid);
    process.exit(1);
  }

  const scheme = useGCM ? 'gcm' : useIV ? 'cbc-iv' : 'legacy';

  const id = 'ivtest-' + Date.now();
  const plaintext = JSON.stringify({
    message: {
      mtype: 'msg', type: 'jsondata', from: 'iRocoX',
      obj: { mtype: 'get', id, data: { item: 'ping' }, type: 'jsonmsg', target: '0.0.0.0' },
      appInfo: { appID: 'com.rottiesoft.circle', version: '1.63', platform: 'test' }
    }
  });

  // iv/tag (when used) are embedded in the message envelope; no top-level fields.
  const body = { message: enc(plaintext, key, scheme, gid) };

  console.log('== REQUEST ==');
  console.log('scheme      :', scheme);
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

  if (reply.message) {
    let out, replyScheme = '?';
    try { const r = decEnvelope(reply.message, key, gid); out = maybeInflate(r.plaintext); replyScheme = r.scheme; }
    catch (e) { out = '<decrypt failed: ' + e.message + '>'; }
    console.log('reply scheme:', replyScheme);
    console.log('>> box replied with:', replyScheme, replyScheme === scheme ? '(mirrors request)' : '(does NOT mirror request!)');
    console.log('== DECRYPTED REPLY (first 400 chars) ==');
    console.log(out.slice(0, 400));
  } else {
    console.log('reply (no message):', JSON.stringify(reply).slice(0, 300));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e && (e.stack || e)); process.exit(1); });
