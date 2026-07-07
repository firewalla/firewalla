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

const chai = require('chai');
const expect = chai.expect;
const crypto = require('crypto');

const EptCloud = require('../encipher');

describe('encipher per-request IV', function () {
  this.timeout(5000);

  let ept;
  // 32-char key, same shape keygen() produces (utf8 -> 32 key bytes)
  const key = crypto.randomBytes(24).toString('base64');
  const msg = JSON.stringify({ hello: 'world', n: 42, s: 'a longer string to span multiple AES blocks' });

  before(() => {
    ept = new EptCloud('test-iv-unit');
  });

  describe('_normalizeIV', () => {
    it('returns a 16-byte zero IV when iv is null/undefined', () => {
      expect(ept._normalizeIV(null).equals(Buffer.alloc(16))).to.be.true;
      expect(ept._normalizeIV(undefined).equals(Buffer.alloc(16))).to.be.true;
    });

    it('accepts a 16-byte Buffer', () => {
      const b = crypto.randomBytes(16);
      expect(ept._normalizeIV(b).equals(b)).to.be.true;
    });

    it('rejects a Buffer of the wrong length', () => {
      expect(() => ept._normalizeIV(Buffer.alloc(8))).to.throw();
      expect(() => ept._normalizeIV(Buffer.alloc(32))).to.throw();
    });

    it('accepts canonical base64 of 16 bytes', () => {
      const b = crypto.randomBytes(16);
      expect(ept._normalizeIV(b.toString('base64')).equals(b)).to.be.true;
    });

    it('rejects base64 that decodes to the wrong length', () => {
      expect(() => ept._normalizeIV(crypto.randomBytes(12).toString('base64'))).to.throw();
      expect(() => ept._normalizeIV(crypto.randomBytes(24).toString('base64'))).to.throw();
    });

    it('rejects malformed / non-canonical base64', () => {
      expect(() => ept._normalizeIV('AAAA')).to.throw();                       // too short
      expect(() => ept._normalizeIV('****************====abcd')).to.throw();    // invalid chars
      expect(() => ept._normalizeIV('AAAAAAAAAAAAAAAAAAAAAAAA')).to.throw();    // 24 chars, no padding
      expect(() => ept._normalizeIV('not-a-valid-iv')).to.throw();
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    it('legacy zero IV round-trips (no iv on either side)', () => {
      const c = ept.encrypt(msg, key);
      expect(ept.decrypt(c, key)).to.equal(msg);
    });

    it('random IV round-trips (Buffer encrypt, base64 decrypt)', () => {
      const iv = crypto.randomBytes(16);
      const c = ept.encrypt(msg, key, iv);
      expect(ept.decrypt(c, key, iv.toString('base64'))).to.equal(msg);
    });

    it('random IV makes ciphertext non-deterministic', () => {
      const c1 = ept.encrypt(msg, key, crypto.randomBytes(16));
      const c2 = ept.encrypt(msg, key, crypto.randomBytes(16));
      expect(c1).to.not.equal(c2);
    });

    it('legacy zero IV is deterministic (the behavior this change mitigates)', () => {
      expect(ept.encrypt(msg, key)).to.equal(ept.encrypt(msg, key));
    });

    it('a random-IV ciphertext does not decrypt back to the plaintext under the zero IV', () => {
      const c = ept.encrypt(msg, key, crypto.randomBytes(16));
      expect(ept.decrypt(c, key)).to.not.equal(msg);
    });

    it('decrypt returns null (does not throw) on a malformed IV', () => {
      const c = ept.encrypt(msg, key, crypto.randomBytes(16));
      expect(ept.decrypt(c, key, 'not-a-valid-iv')).to.equal(null);
    });

    it('encrypt throws on a malformed IV', () => {
      expect(() => ept.encrypt(msg, key, 'not-a-valid-iv')).to.throw();
    });
  });
});
