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
    it('legacy: encrypt() with no iv returns bare base64 and round-trips', () => {
      const c = ept.encrypt(msg, key);
      expect(c[0]).to.not.equal('{'); // not the JSON envelope
      expect(ept.decrypt(c, key)).to.equal(msg);
    });

    it('encrypt() with an iv returns a { iv, message } envelope that round-trips', () => {
      const c = ept.encrypt(msg, key, crypto.randomBytes(16));
      const env = JSON.parse(c);
      expect(env).to.have.property('iv');
      expect(env).to.have.property('message');
      expect(ept.decrypt(c, key)).to.equal(msg); // iv read from envelope, not passed
    });

    it('random IV makes the envelope non-deterministic', () => {
      const c1 = ept.encrypt(msg, key, crypto.randomBytes(16));
      const c2 = ept.encrypt(msg, key, crypto.randomBytes(16));
      expect(c1).to.not.equal(c2);
    });

    it('legacy zero IV is deterministic (the behavior this change mitigates)', () => {
      expect(ept.encrypt(msg, key)).to.equal(ept.encrypt(msg, key));
    });

    it('decrypt accepts a JSON-encoded legacy string', () => {
      const bare = ept.encrypt(msg, key);
      expect(ept.decrypt(JSON.stringify(bare), key)).to.equal(msg);
    });

    it('decrypt treats { message } without iv as legacy zero IV', () => {
      const bare = ept.encrypt(msg, key);
      expect(ept.decrypt(JSON.stringify({ message: bare }), key)).to.equal(msg);
    });

    it('decrypt returns null on an envelope missing message', () => {
      expect(ept.decrypt(JSON.stringify({}), key)).to.equal(null);
      expect(ept.decrypt(JSON.stringify({ iv: crypto.randomBytes(16).toString('base64') }), key)).to.equal(null);
    });

    it('decrypt returns null (does not throw) on a malformed iv in the envelope', () => {
      expect(ept.decrypt(JSON.stringify({ iv: 'not-a-valid-iv', message: 'AAAAAAAAAAAAAAAAAAAAAA==' }), key)).to.equal(null);
    });

    it('encrypt throws on a malformed IV', () => {
      expect(() => ept.encrypt(msg, key, 'not-a-valid-iv')).to.throw();
    });
  });

  describe('_parseEnvelope', () => {
    it('raw base64 (not JSON) -> legacy, no iv', () => {
      const e = ept._parseEnvelope('uJPZ6RTZAAWR1Wmc');
      expect(e.iv).to.equal(null);
      expect(e.ct).to.equal('uJPZ6RTZAAWR1Wmc');
    });
    it('JSON string -> legacy, no iv', () => {
      const e = ept._parseEnvelope('"uJPZ6RTZAAWR1Wmc"');
      expect(e.iv).to.equal(null);
      expect(e.ct).to.equal('uJPZ6RTZAAWR1Wmc');
    });
    it('{ iv, message } -> both parsed', () => {
      const e = ept._parseEnvelope(JSON.stringify({ iv: 'AA==', message: 'BB' }));
      expect(e.iv).to.equal('AA==');
      expect(e.ct).to.equal('BB');
    });
    it('{ message } -> legacy fallback', () => {
      const e = ept._parseEnvelope(JSON.stringify({ message: 'BB' }));
      expect(e.iv).to.equal(null);
      expect(e.ct).to.equal('BB');
    });
    it('object without message -> invalid', () => {
      expect(ept._parseEnvelope(JSON.stringify({})).invalid).to.equal(true);
      expect(ept._parseEnvelope(JSON.stringify({ iv: 'AA==' })).invalid).to.equal(true);
    });
  });
});
