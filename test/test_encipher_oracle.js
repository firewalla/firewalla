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

// Regression tests for the CBC padding oracle in the unauthenticated
// encrypted-message API (firewalla/firecommit#9400):
//  - every decrypt/parse failure in decryptRequest must reject with the same
//    opaque "decrypt_error" (bad padding must be indistinguishable from valid
//    padding + non-JSON plaintext),
//  - once a group has made a successful GCM request on the enforcing path,
//    CBC/legacy requests for it are rejected (no client-controlled downgrade),
//  - oversized input is rejected before any crypto work.

const chai = require('chai');
const expect = chai.expect;
const crypto = require('crypto');

const EptCloud = require('../encipher');

describe('encipher decryptRequest uniform errors and GCM policy', function () {
  this.timeout(5000);

  let ept;
  const key = crypto.randomBytes(24).toString('base64');
  const gid = 'oracle-test-gid-' + crypto.randomBytes(4).toString('hex');
  const validMessage = JSON.stringify({ message: { mtype: 'msg', obj: { id: 1 } } });

  const rejectionOf = p => p.then(() => null, err => err);

  before(() => {
    ept = new EptCloud('test-oracle-unit');
    ept.gid = gid; // GCM AAD source
    ept.getKey = (g, refresh, cb) => cb(null, key);
  });

  after(async () => {
    // remove the persisted migration flag so reruns and other tests start clean
    const rclient = require('../util/redis_manager.js').getRedisClient();
    const Constants = require('../net2/Constants.js');
    await rclient.hdelAsync(Constants.REDIS_KEY_EPT_GCM_GIDS, gid).catch(() => undefined);
  });

  describe('uniform decrypt_error (padding-oracle regression)', () => {
    it('accepts a valid CBC request', async () => {
      const { decrypted, scheme } = await ept.decryptRequest(gid, ept.encrypt(validMessage, key, crypto.randomBytes(16)));
      expect(decrypted.message.mtype).to.equal('msg');
      expect(scheme).to.equal('cbc-iv');
    });

    it('rejects invalid padding with decrypt_error', async () => {
      const env = JSON.parse(ept.encrypt(validMessage, key, crypto.randomBytes(16)));
      const ct = Buffer.from(env.message, 'base64');
      ct[ct.length - 1] ^= 1; // corrupt final block -> padding check fails w.h.p.
      env.message = ct.toString('base64');
      const err = await rejectionOf(ept.decryptRequest(gid, JSON.stringify(env)));
      expect(err).to.be.an('error');
      expect(err.message).to.equal('decrypt_error');
    });

    it('rejects valid padding + non-JSON plaintext with the SAME decrypt_error', async () => {
      // decrypts cleanly but the plaintext is not JSON; before the fix this
      // rejected "Malformed JSON" -> HTTP 400 vs 412, the padding oracle.
      const err = await rejectionOf(ept.decryptRequest(gid, ept.encrypt('not json', key, crypto.randomBytes(16))));
      expect(err).to.be.an('error');
      expect(err.message).to.equal('decrypt_error');
    });

    it('rejects an invalid envelope with the same decrypt_error', async () => {
      const err = await rejectionOf(ept.decryptRequest(gid, JSON.stringify({ iv: 'AA==' })));
      expect(err.message).to.equal('decrypt_error');
    });

    it('rejects oversized input before decryption with the same decrypt_error', async () => {
      const big = 'A'.repeat(5 * 1024 * 1024 + 1);
      expect((await rejectionOf(ept.decryptRequest(gid, big))).message).to.equal('decrypt_error');
      expect((await rejectionOf(ept.decryptRequest(gid, { message: big }))).message).to.equal('decrypt_error');
    });
  });

  describe('GCM anti-downgrade policy', () => {
    it('CBC is accepted on the enforcing path before the group migrates', async () => {
      expect(await ept.isGcmMigrated(gid)).to.equal(false);
      const { scheme } = await ept.decryptRequest(gid, ept.encrypt(validMessage, key, crypto.randomBytes(16)), { enforceGcmPolicy: true });
      expect(scheme).to.equal('cbc-iv');
    });

    it('a successful GCM request marks the group migrated', async () => {
      const { scheme } = await ept.decryptRequest(gid, ept._encryptGcm(validMessage, key), { enforceGcmPolicy: true });
      expect(scheme).to.equal('gcm');
      expect(await ept.isGcmMigrated(gid)).to.equal(true);
    });

    it('CBC and legacy requests are rejected for a migrated group on the enforcing path', async () => {
      const cbc = ept.encrypt(validMessage, key, crypto.randomBytes(16));
      expect((await rejectionOf(ept.decryptRequest(gid, cbc, { enforceGcmPolicy: true }))).message).to.equal('decrypt_error');
      const legacy = ept.encrypt(validMessage, key); // zero-IV bare base64
      expect((await rejectionOf(ept.decryptRequest(gid, legacy, { enforceGcmPolicy: true }))).message).to.equal('decrypt_error');
    });

    it('GCM requests still work for a migrated group', async () => {
      const { decrypted, scheme } = await ept.decryptRequest(gid, ept._encryptGcm(validMessage, key), { enforceGcmPolicy: true });
      expect(scheme).to.equal('gcm');
      expect(decrypted.message.mtype).to.equal('msg');
    });

    it('non-enforcing paths (authenticated transports) still accept CBC for a migrated group', async () => {
      const { scheme } = await ept.decryptRequest(gid, ept.encrypt(validMessage, key, crypto.randomBytes(16)));
      expect(scheme).to.equal('cbc-iv');
    });

    it('a failed GCM request does not mark an unmigrated group', async () => {
      const gid2 = gid + '-unmigrated';
      const ept2 = Object.create(ept);
      ept2.gid = gid2;
      ept2._gcmGids = {};
      const o = JSON.parse(ept._encryptGcm(validMessage, key)); // AAD = gid, not gid2
      const err = await rejectionOf(ept2.decryptRequest(gid2, JSON.stringify(o), { enforceGcmPolicy: true }));
      expect(err.message).to.equal('decrypt_error');
      expect(ept2._gcmGids[gid2]).to.equal(undefined);
    });
  });
});
