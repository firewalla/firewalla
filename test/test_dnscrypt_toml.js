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
const fs = require('fs');
const os = require('os');
const path = require('path');
// no noPreserveCache(): it evicts the proxied module's dependencies from require.cache,
// which leaves other test files running against half-reloaded modules
const proxyquire = require('proxyquire').noCallThru();

const HOME = path.resolve(__dirname, '..');
const RUNTIME = fs.mkdtempSync(path.join(os.tmpdir(), 'dnscrypt-test-'));
const DEFAULTS = require('../extension/dnscrypt/defaultServers.json').servers;

const logger = () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} });

// Lets a test say what dnscrypt-proxy would make of each candidate config.
// Records every config it was handed, so a test can count the checks too.
let execFileImpl = async () => {};
const seen = [];

// A rejection is a non-zero exit status; a validator that never ran reports a
// spawn error instead, and the two must not be confused.
const rejects = (reason) => Object.assign(new Error('Command failed'), { code: 255, stdout: `[FATAL] ${reason}` });
const cannotRun = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
const TOML_PATH = () => path.join(RUNTIME, 'dnscrypt.toml');

function makeRedis(values) {
  return {
    getAsync: async (k) => (k in values ? values[k] : null),
    setAsync: async () => 'OK',
    unlinkAsync: async () => 1,
  };
}

function loadDnscrypt(redisValues) {
  return proxyquire('../extension/dnscrypt/dnscrypt.js', {
    '../../net2/logger': logger,
    '../../net2/Firewalla.js': {
      getFirewallaHome: () => HOME,
      getRuntimeInfoFolder: () => RUNTIME,
    },
    '../../util/util.js': { fileRemove: async () => {} },
    '../../util/redis_manager': { getRedisClient: () => makeRedis(redisValues || {}) },
    'child-process-promise': {
      execFile: async (bin, args) => {
        const cfg = fs.readFileSync(args[args.indexOf('-config') + 1], 'utf8');
        seen.push(cfg);
        return execFileImpl(cfg);
      },
    },
    '../../lib/Bone': { hashsetAsync: async () => null },
    '../../net2/Constants.js': { ACL_VIRT_WAN_GROUP_PREFIX: 'virt_wan_group:' },
    '../vpnclient/VPNClient': { getRouteMarkKey: () => 'mark' },
    '../../net2/VirtWanGroup.js': { getRouteMarkKey: () => 'mark' },
  });
}

const STAMP = 'sdns://AgcAAAAAAAAAAAAOZG5zLm5leHRkbnMuaW8JL3Rlc3Rvbmx5';
const staticKeys = (toml) => (toml.match(/^\[static\..*\]$/gm) || []);
const serverNames = (toml) => JSON.parse(/^server_names = (.*)$/m.exec(toml)[1]);

describe('dnscrypt toml generation', function () {
  let dc;

  beforeEach(function () {
    seen.length = 0;
    execFileImpl = async () => {};
    try { fs.unlinkSync(TOML_PATH()); } catch (err) { /* no config from a previous test */ }
    dc = loadDnscrypt();
  });

  describe('filterUsableServers', function () {
    it('keeps every bundled default, whichever stamp prefix it uses', function () {
      // cloudflare and google ship "sdns:", quad9 ships "sdns://"; dnscrypt-proxy
      // takes both, so dropping either silently changes the resolver in use.
      const kept = dc.filterUsableServers(DEFAULTS).map((s) => s.name);
      expect(kept).to.deep.equal(DEFAULTS.map((s) => s.name));
      expect(DEFAULTS.some((s) => s.stamp.startsWith('sdns://'))).to.be.true;
      expect(DEFAULTS.some((s) => !s.stamp.startsWith('sdns://'))).to.be.true;
    });

    it('strips base64 padding, which dnscrypt-proxy rejects', function () {
      const kept = dc.filterUsableServers([{ name: 'padded', stamp: STAMP + '==' }]);
      expect(kept).to.have.length(1);
      expect(kept[0].stamp).to.equal(STAMP);
    });

    it('drops a stamp that is not base64 at all', function () {
      expect(dc.filterUsableServers([{ name: 'a', stamp: "sdns://A'BC" }])).to.be.empty;
      expect(dc.filterUsableServers([{ name: 'b', stamp: 'sdns://AB CD' }])).to.be.empty;
      expect(dc.filterUsableServers([{ name: 'c', stamp: 'https://1.1.1.1/dns-query' }])).to.be.empty;
      // base64 that cannot round-trip: a length the encoder would never emit
      expect(dc.filterUsableServers([{ name: 'd', stamp: 'sdns://AgcAA' }])).to.be.empty;
    });

    it('drops an entry with no name or no stamp', function () {
      expect(dc.filterUsableServers([{ name: 'a' }, { stamp: STAMP }, null, { name: 42, stamp: STAMP }])).to.be.empty;
    });

    it('drops a name with no TOML spelling', function () {
      expect(dc.filterUsableServers([{ name: 'del\u007f', stamp: STAMP }])).to.be.empty;
      expect(dc.filterUsableServers([{ name: 'lone\ud800', stamp: STAMP }])).to.be.empty;
      // a properly paired surrogate is an ordinary character and must survive
      expect(dc.filterUsableServers([{ name: 'emoji\u{1f600}', stamp: STAMP }])).to.have.length(1);
    });

    it('keeps the first of a duplicated name', function () {
      const kept = dc.filterUsableServers([
        { name: 'opendns', stamp: STAMP },
        { name: 'opendns', stamp: 'sdns://AgMAAAAAAAAABzkuOS45Ljk' },
      ]);
      expect(kept).to.have.length(1);
      expect(kept[0].stamp).to.equal(STAMP);
    });
  });

  describe('allServersToToml', function () {
    it('quotes a name holding an apostrophe instead of ending the key early', function () {
      const toml = dc.allServersToToml([{ name: "Bob's DNS", stamp: STAMP }]);
      expect(staticKeys(toml)).to.deep.equal(['[static."Bob\'s DNS"]']);
    });

    it('escapes quotes, backslashes and newlines', function () {
      const name = 'a"b\\c\nd';
      const toml = dc.allServersToToml([{ name, stamp: STAMP }]);
      expect(staticKeys(toml)).to.deep.equal(['[static."a\\"b\\\\c\\nd"]']);
      expect(toml.split('\n')).to.have.length(3); // key, stamp, trailing - no injected lines
    });
  });

  describe('prepareConfig', function () {
    const withServers = (customized, selected) => loadDnscrypt({
      'ext.dnscrypt.customizedServers': JSON.stringify(customized),
      'ext.dnscrypt.servers': JSON.stringify(selected),
    });

    it('writes the config once dnscrypt-proxy accepts it', async function () {
      dc = withServers([{ name: 'mine', stamp: STAMP }], ['quad9', 'mine']);
      expect(await dc.prepareConfig()).to.be.true;
      expect(seen).to.have.length(1);
      const toml = fs.readFileSync(path.join(RUNTIME, 'dnscrypt.toml'), 'utf8');
      expect(serverNames(toml)).to.deep.equal(['quad9', 'mine']);
      expect(staticKeys(toml)).to.include('[static."mine"]');
    });

    it('names only servers it actually wrote in server_names', async function () {
      dc = withServers([{ name: 'bad', stamp: 'not-a-stamp' }], ['quad9', 'bad']);
      await dc.prepareConfig();
      const toml = fs.readFileSync(path.join(RUNTIME, 'dnscrypt.toml'), 'utf8');
      expect(serverNames(toml)).to.deep.equal(['quad9']);
      expect(staticKeys(toml)).to.not.include('[static."bad"]');
    });

    it('drops only the entry dnscrypt-proxy objects to, keeping the rest', async function () {
      // "rotten" looks like a stamp but does not decode into one - exactly what
      // filterUsableServers cannot know and only dnscrypt-proxy can say.
      dc = withServers([
        { name: 'rotten', stamp: 'sdns://Ag' },
        { name: 'good', stamp: STAMP },
      ], ['quad9', 'rotten', 'good']);
      execFileImpl = async (cfg) => {
        if (cfg.includes('[static."rotten"]')) throw rejects('Stamp is too short');
      };
      expect(await dc.prepareConfig()).to.be.true;
      const toml = fs.readFileSync(path.join(RUNTIME, 'dnscrypt.toml'), 'utf8');
      expect(staticKeys(toml)).to.not.include('[static."rotten"]');
      expect(staticKeys(toml)).to.include('[static."good"]');
      expect(serverNames(toml)).to.deep.equal(['quad9', 'good']);
    });

    it('keeps every server when the validator cannot be run at all', async function () {
      // A missing or unrunnable binary says nothing about the config. Reading
      // that as a rejection would drop every healthy server and restart into
      // an empty config.
      dc = withServers([{ name: 'mine', stamp: STAMP }], ['quad9', 'mine']);
      execFileImpl = async () => { throw cannotRun(); };
      expect(await dc.prepareConfig()).to.be.true;
      const toml = fs.readFileSync(TOML_PATH(), 'utf8');
      expect(serverNames(toml)).to.deep.equal(['quad9', 'mine']);
      expect(staticKeys(toml)).to.include('[static."mine"]');
    });

    it('keeps the running config when the validated one is still rejected', async function () {
      dc = withServers([{ name: 'mine', stamp: STAMP }], ['mine']);
      await dc.prepareConfig();
      const before = fs.readFileSync(TOML_PATH(), 'utf8');

      execFileImpl = async () => { throw rejects('rejected for the sake of argument'); };
      expect(await dc.prepareConfig()).to.be.false;
      expect(fs.readFileSync(TOML_PATH(), 'utf8')).to.equal(before);
    });

    it('reports no change when dropping a rejected entry reproduces the running config', async function () {
      // The rejected entry stays in redis, so every refresh re-renders it. What
      // finally gets written is identical, and must not restart the proxy.
      dc = withServers([{ name: 'rotten', stamp: 'sdns://Ag' }], ['quad9', 'rotten']);
      execFileImpl = async (cfg) => {
        if (cfg.includes('[static."rotten"]')) throw rejects('Stamp is too short');
      };
      expect(await dc.prepareConfig({}, true)).to.be.true;
      const written = fs.readFileSync(TOML_PATH(), 'utf8');

      expect(await dc.prepareConfig({}, true)).to.be.false;
      expect(fs.readFileSync(TOML_PATH(), 'utf8')).to.equal(written);
    });

    it('does not ask dnscrypt-proxy again when the config has not changed', async function () {
      dc = withServers([{ name: 'mine', stamp: STAMP }], ['mine']);
      await dc.prepareConfig();
      seen.length = 0;
      expect(await dc.prepareConfig({}, true)).to.be.false;
      expect(seen).to.be.empty;
    });
  });
});
