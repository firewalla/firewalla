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

const { expect } = require('chai');
const proxyquire = require('proxyquire');

const REDIS_KEY = 'kernel_crash_info';
const PSTORE_PATH = '/sys/fs/pstore';
const PSTORE_ARCHIVE_PATH = '/log/system/pstore';

// ─── in-memory Redis string stub ───────────────────────────────────────────

class FakeRedis {
  constructor() { this._store = {}; }
  async getAsync(key) { return this._store[key] !== undefined ? this._store[key] : null; }
  async setAsync(key, val) { this._store[key] = val; }
  seed(obj) { this._store[REDIS_KEY] = JSON.stringify(obj); }
}

// ─── quoted-path extraction (skips the fixed grep/pattern literals) ────────

function extractPaths(cmd) {
  const quoted = cmd.match(/"([^"]*)"/g) || [];
  return quoted
    .map(s => s.slice(1, -1))
    .filter(s => s !== 'Kernel panic' && s !== 'Modules linked in:.*xt_udp_tls');
}

// ─── fake exec: routes on command shape, records every call ───────────────
//
// fixtures:
//   modinfoOutput: string | null            -- stdout for `modinfo ...` (null => reject)
//   dmesgFindOutput: string                 -- stdout for the pstore `find ... dmesg-*` scan
//   fileContents: { path: content }         -- backing content for grep/cat over dmesg files
//   archiveDirs: string[]                   -- stdout lines for `ls -1 ARCHIVE_PATH | sort -n`
//   failOn: (cmd) => boolean                -- force a command to reject
function makeExec(fixtures) {
  const execLog = [];
  const exec = async (cmd) => {
    execLog.push(cmd);
    if (fixtures.failOn && fixtures.failOn(cmd)) {
      throw new Error(`forced failure: ${cmd}`);
    }
    if (cmd.startsWith('modinfo ')) {
      if (fixtures.modinfoOutput == null) throw new Error('modinfo: command not found');
      return { stdout: fixtures.modinfoOutput };
    }
    if (cmd.includes('-name "dmesg-*"')) {
      return { stdout: fixtures.dmesgFindOutput || '' };
    }
    if (cmd.includes('grep -l "Kernel panic"')) {
      const paths = extractPaths(cmd);
      const matches = paths.filter(p => (fixtures.fileContents[p] || '').includes('Kernel panic'));
      if (matches.length === 0) throw new Error('grep: no match'); // grep -l exits 1 on no match
      return { stdout: matches.join('\n') };
    }
    if (cmd.includes('grep -Eq "Modules linked in:.*xt_udp_tls"')) {
      const paths = extractPaths(cmd);
      const matched = paths.some(p => /Modules linked in:.*xt_udp_tls/.test(fixtures.fileContents[p] || ''));
      if (!matched) throw new Error('grep -q: no match');
      return { stdout: '' };
    }
    if (cmd.startsWith(`ls -1 ${PSTORE_ARCHIVE_PATH}`)) {
      return { stdout: (fixtures.archiveDirs || []).join('\n') };
    }
    // mkdir / rm / cp / find -delete and anything else: succeed silently
    return { stdout: '' };
  };
  return { exec, execLog };
}

function loadKCM(fakeRedis, execImpl) {
  const logs = { info: [], debug: [], warn: [], error: [] };
  const mod = proxyquire('../net2/KernelCrashMonitor.js', {
    '../util/redis_manager.js': { getRedisClient: () => fakeRedis, '@noCallThru': true },
    './logger.js': () => ({
      info: (...a) => logs.info.push(a.join(' ')),
      debug: (...a) => logs.debug.push(a.join(' ')),
      warn: (...a) => logs.warn.push(a.join(' ')),
      error: (...a) => logs.error.push(a.join(' ')),
    }),
    'child-process-promise': { exec: execImpl, '@noCallThru': true },
  });
  mod._logs = logs;
  return mod;
}

function modinfoStdout(version, srcversion) {
  return `filename:       /lib/modules/xt_udp_tls.ko\nversion:        ${version}\nsrcversion:     ${srcversion}\ndepends:        \n`;
}

describe('KernelCrashMonitor', function () {
  this.timeout(5000);

  let fakeRedis;
  beforeEach(function () { fakeRedis = new FakeRedis(); });

  // ── getCrashInfo / readCrashInfo ──────────────────────────────────────────

  describe('getCrashInfo', function () {
    it('returns {} when redis has no entry', async function () {
      const { exec } = makeExec({});
      const kcm = loadKCM(fakeRedis, exec);
      expect(await kcm.getCrashInfo()).to.deep.equal({});
    });

    it('returns the parsed object when redis has valid JSON', async function () {
      fakeRedis.seed({ crashesCount: 2, shouldDisableUdpTls: true });
      const { exec } = makeExec({});
      const kcm = loadKCM(fakeRedis, exec);
      expect(await kcm.getCrashInfo()).to.deep.equal({ crashesCount: 2, shouldDisableUdpTls: true });
    });

    it('resets to {} and warns when the stored value is invalid JSON', async function () {
      fakeRedis._store[REDIS_KEY] = '{not json';
      const { exec } = makeExec({});
      const kcm = loadKCM(fakeRedis, exec);
      const info = await kcm.getCrashInfo();
      expect(info).to.deep.equal({});
      expect(kcm._logs.warn.some(m => m.includes('kernel_crash_info'))).to.be.true;
    });
  });

  // ── shouldDisableUdpTls ────────────────────────────────────────────────────

  describe('shouldDisableUdpTls', function () {
    it('returns true when crashInfo.shouldDisableUdpTls is true', async function () {
      fakeRedis.seed({ shouldDisableUdpTls: true });
      const { exec } = makeExec({});
      const kcm = loadKCM(fakeRedis, exec);
      expect(await kcm.shouldDisableUdpTls()).to.be.true;
    });

    it('returns false when unset', async function () {
      const { exec } = makeExec({});
      const kcm = loadKCM(fakeRedis, exec);
      expect(await kcm.shouldDisableUdpTls()).to.be.false;
    });

    it('returns false and logs an error when redis fails', async function () {
      const { exec } = makeExec({});
      const brokenRedis = { getAsync: async () => { throw new Error('redis down'); } };
      const kcm = loadKCM(brokenRedis, exec);
      expect(await kcm.shouldDisableUdpTls()).to.be.false;
      expect(kcm._logs.error.length).to.equal(1);
    });
  });

  // ── onUdpTlsModuleLoaded ───────────────────────────────────────────────────

  describe('onUdpTlsModuleLoaded', function () {
    it('records the module version and clears shouldDisableUdpTls', async function () {
      fakeRedis.seed({ shouldDisableUdpTls: true, udpTlsDisabledOn: 12345 });
      const { exec } = makeExec({ modinfoOutput: modinfoStdout('1.0', 'abc123') });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.onUdpTlsModuleLoaded('/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.udpModuleVersion).to.deep.equal({ version: '1.0', srcversion: 'abc123' });
      expect(info.shouldDisableUdpTls).to.be.false;
    });

    it('defaults to the module name "xt_udp_tls" when no path is given', async function () {
      const { exec, execLog } = makeExec({ modinfoOutput: modinfoStdout('2.0', 'def456') });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.onUdpTlsModuleLoaded();

      expect(execLog.some(c => c === 'modinfo xt_udp_tls')).to.be.true;
    });

    it('still clears shouldDisableUdpTls when modinfo fails, without clobbering stored version', async function () {
      fakeRedis.seed({ shouldDisableUdpTls: true, udpModuleVersion: { version: '1.0', srcversion: 'abc' } });
      const { exec } = makeExec({ modinfoOutput: null });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls');

      const info = await kcm.getCrashInfo();
      expect(info.udpModuleVersion).to.deep.equal({ version: '1.0', srcversion: 'abc' });
      expect(info.shouldDisableUdpTls).to.be.false;
    });

    it('logs an error and does not throw when redis save fails', async function () {
      const { exec } = makeExec({ modinfoOutput: modinfoStdout('1.0', 'abc') });
      const brokenRedis = {
        getAsync: async () => null,
        setAsync: async () => { throw new Error('redis write failed'); },
      };
      const kcm = loadKCM(brokenRedis, exec);

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls');
      expect(kcm._logs.error.length).to.equal(1);
    });
  });

  // ── checkPstoreAndUpdateRedis ──────────────────────────────────────────────

  describe('checkPstoreAndUpdateRedis', function () {
    it('does nothing when no dmesg files exist in pstore', async function () {
      const { exec, execLog } = makeExec({ dmesgFindOutput: '' });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      expect(await kcm.getCrashInfo()).to.deep.equal({});
      expect(execLog.some(c => c.startsWith('sudo cp -a'))).to.be.false;
    });

    it('archives pstore but leaves crash info untouched when no "Kernel panic" is found', async function () {
      const dmesgFindOutput = `100.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { exec, execLog } = makeExec({
        dmesgFindOutput,
        fileContents: { [`${PSTORE_PATH}/dmesg-a`]: 'some unrelated log output' },
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      expect(await kcm.getCrashInfo()).to.deep.equal({});
      // still archives to free up pstore space, using the newest dmesg file's ts (100)
      expect(execLog.some(c => c.startsWith(`sudo mkdir -p "${PSTORE_ARCHIVE_PATH}/100"`))).to.be.true;
      expect(execLog.some(c => c.includes(`find ${PSTORE_PATH} -mindepth 1 -delete`))).to.be.true;
    });

    it('archives pstore but does not touch crashesCount for a non-udp-tls kernel panic', async function () {
      const dmesgFindOutput = `200.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { exec } = makeExec({
        dmesgFindOutput,
        fileContents: { [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: ext4 usb_storage' },
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.crashesCount).to.be.undefined;
      expect(info.shouldDisableUdpTls).to.be.undefined;
    });

    it('records a udp-tls crash: bumps crashesCount and sets shouldDisableUdpTls', async function () {
      const dmesgFindOutput = `300.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { exec } = makeExec({
        dmesgFindOutput,
        modinfoOutput: modinfoStdout('1.0', 'abc'),
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.lastCrashTS).to.equal(300);
      expect(info.crashesCount).to.equal(1);
      expect(info.shouldDisableUdpTls).to.be.true;
      expect(info.udpTlsDisabledOn).to.be.a('number').and.above(0);
    });

    it('does not double-count a udp-tls crash that is not newer than the last recorded one', async function () {
      fakeRedis.seed({ lastCrashTS: 500, crashesCount: 1, shouldDisableUdpTls: true });
      const dmesgFindOutput = `500.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { exec } = makeExec({
        dmesgFindOutput,
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.crashesCount).to.equal(1);
      expect(info.lastCrashTS).to.equal(500);
    });

    it('bumps crashesCount again for a newer udp-tls crash', async function () {
      fakeRedis.seed({ lastCrashTS: 100, crashesCount: 1, shouldDisableUdpTls: true });
      const dmesgFindOutput = `600.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { exec } = makeExec({
        dmesgFindOutput,
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.crashesCount).to.equal(2);
      expect(info.lastCrashTS).to.equal(600);
    });

    it('picks the newest dmesg file\'s panic when several are found', async function () {
      const dmesgFindOutput =
        `700.0 ${PSTORE_PATH}/dmesg-old\n` +
        `900.0 ${PSTORE_PATH}/dmesg-new\n`;
      const { exec } = makeExec({
        dmesgFindOutput,
        fileContents: {
          [`${PSTORE_PATH}/dmesg-old`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls',
          [`${PSTORE_PATH}/dmesg-new`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls',
        },
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      expect((await kcm.getCrashInfo()).lastCrashTS).to.equal(900);
    });

    it('re-enables UDP TLS when the module version changed after a prior crash-disable', async function () {
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '1.0', srcversion: 'old' },
      });
      const { exec } = makeExec({
        dmesgFindOutput: '', // no new crash this run
        modinfoOutput: modinfoStdout('2.0', 'new'),
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.false;
      expect(info.udpTlsDisabledOn).to.equal(0);
    });

    it('keeps UDP TLS disabled when the module version is unchanged', async function () {
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '1.0', srcversion: 'same' },
      });
      const { exec } = makeExec({
        dmesgFindOutput: '',
        modinfoOutput: modinfoStdout('1.0', 'same'),
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.true;
    });

    it('keeps UDP TLS disabled when the current version cannot be determined (module not yet installed)', async function () {
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '1.0', srcversion: 'old' },
      });
      const { exec } = makeExec({
        dmesgFindOutput: '',
        modinfoOutput: null, // koPath doesn't exist yet -> unknown version
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.true;
    });

    it('cleans up old pstore archives, keeping only the most recent ones, before writing the new one', async function () {
      const dmesgFindOutput = `400.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { exec, execLog } = makeExec({
        dmesgFindOutput,
        fileContents: { [`${PSTORE_PATH}/dmesg-a`]: 'no panic here' },
        archiveDirs: ['100', '200', '300'], // 3 existing archives, PSTORE_ARCHIVE_MAX_DIRS=3 keeps 2
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');

      expect(execLog.some(c => c === `sudo rm -rf "${PSTORE_ARCHIVE_PATH}/100"`)).to.be.true;
      expect(execLog.some(c => c === `sudo rm -rf "${PSTORE_ARCHIVE_PATH}/200"`)).to.be.false;
      expect(execLog.some(c => c === `sudo rm -rf "${PSTORE_ARCHIVE_PATH}/300"`)).to.be.false;
      expect(execLog.some(c => c.startsWith(`sudo mkdir -p "${PSTORE_ARCHIVE_PATH}/400"`))).to.be.true;
    });

    it('does not throw when pstore archiving fails', async function () {
      const dmesgFindOutput = `400.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { exec } = makeExec({
        dmesgFindOutput,
        fileContents: { [`${PSTORE_PATH}/dmesg-a`]: 'no panic here' },
        failOn: (cmd) => cmd.startsWith(`sudo mkdir -p ${PSTORE_ARCHIVE_PATH}`),
      });
      const kcm = loadKCM(fakeRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');
      expect(kcm._logs.error.some(m => m.includes('archive/clear pstore'))).to.be.true;
    });

    it('does not throw when redis is unavailable', async function () {
      const { exec } = makeExec({ dmesgFindOutput: '' });
      const brokenRedis = { getAsync: async () => { throw new Error('redis down'); } };
      const kcm = loadKCM(brokenRedis, exec);

      await kcm.checkPstoreAndUpdateRedis('/lib/modules/xt_udp_tls.ko');
      expect(kcm._logs.error.some(m => m.includes('checkPstoreAndUpdateRedis'))).to.be.true;
    });
  });
});
