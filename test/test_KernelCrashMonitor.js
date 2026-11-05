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
  // emulates SET key val [NX] [EX seconds]: NX fails (returns null) if the key is already set
  async setAsync(key, val, ...opts) {
    if (opts[0] === 'NX' && this._store[key] !== undefined) return null;
    this._store[key] = val;
    return 'OK';
  }
  // emulates the compare-and-delete lua script used by releaseLock()
  async evalAsync(script, numKeys, key, token) {
    if (this._store[key] === token) {
      delete this._store[key];
      return 1;
    }
    return 0;
  }
  seed(obj) { this._store[REDIS_KEY] = JSON.stringify(obj); }
}

// ─── fake execFile: routes on (file, args) shape, records every call ──────
//
// fixtures:
//   modinfoOutput: string | null            -- stdout for `modinfo <arg>` (null => reject)
//   koDescribe: string | undefined          -- stdout for `tls_module_id.sh describe <koPath>`,
//                                              e.g. "version=1.0\nsrcversion=abc\nid=buildid:x"
//                                              (undefined => reject, i.e. the .ko yields nothing)
//   koMtime: number | undefined             -- mtime (sec) of the .ko itself, for `stat -L -c %Y`
//   koLinkMtime: number | undefined         -- mtime (sec) of the koPath symlink, for `stat -c %Y`
//                                              (defaults to koMtime, i.e. koPath is a plain file)
//   dmesgFindOutput: string                 -- stdout for the pstore `find ... -name dmesg-*` scan
//   fileContents: { path: content }         -- backing content for grep/cat over dmesg files
//   archiveDirs: string[]                   -- stdout lines for `ls -1 ARCHIVE_PATH`
//   failOn: (cmd) => boolean                -- force a command to reject (cmd = "file arg1 arg2 ...")
function makeExecFile(fixtures) {
  const execLog = [];
  const execFile = async (file, args = []) => {
    const cmd = [file, ...args].join(' ');
    execLog.push(cmd);
    if (fixtures.failOn && fixtures.failOn(cmd)) {
      throw new Error(`forced failure: ${cmd}`);
    }
    if (file === 'modinfo') {
      if (fixtures.modinfoOutput == null) throw new Error('modinfo: command not found');
      return { stdout: fixtures.modinfoOutput };
    }
    if (file.endsWith('/tls_module_id.sh')) {
      if (fixtures.koDescribe === undefined) throw new Error(`tls_module_id.sh: nothing for ${args[1]}`);
      return { stdout: `${fixtures.koDescribe}\n` };
    }
    if (file === 'stat' && args.includes('%Y')) {
      // `stat -L` dereferences the symlink (the real .ko), plain `stat` reports koPath itself
      const mtime = args.includes('-L') ? fixtures.koMtime
        : (fixtures.koLinkMtime !== undefined ? fixtures.koLinkMtime : fixtures.koMtime);
      if (mtime === undefined) return { stdout: '' }; // unknown mtime => null
      return { stdout: String(mtime) };
    }
    if (file === 'sudo' && args[0] === 'find' && args.includes('-name')) {
      return { stdout: fixtures.dmesgFindOutput || '' };
    }
    if (file === 'sudo' && args[0] === 'grep' && args[1] === '-l') {
      const paths = args.slice(3); // ['grep', '-l', 'Kernel panic', ...paths]
      const matches = paths.filter(p => (fixtures.fileContents[p] || '').includes('Kernel panic'));
      if (matches.length === 0) throw new Error('grep: no match'); // grep -l exits 1 on no match
      return { stdout: matches.join('\n') };
    }
    if (file === 'sudo' && args[0] === 'cat') {
      const paths = args.slice(1);
      return { stdout: paths.map(p => fixtures.fileContents[p] || '').join('') };
    }
    if (file === 'ls') {
      return { stdout: (fixtures.archiveDirs || []).join('\n') };
    }
    // mkdir / rm / cp / find -delete and anything else: succeed silently
    return { stdout: '' };
  };
  return { execFile, execLog };
}

function loadKCM(fakeRedis, execFileImpl) {
  const logs = { info: [], debug: [], warn: [], error: [] };
  const mod = proxyquire('../net2/KernelCrashMonitor.js', {
    '../util/redis_manager.js': { getRedisClient: () => fakeRedis, '@noCallThru': true },
    './logger.js': () => ({
      info: (...a) => logs.info.push(a.join(' ')),
      debug: (...a) => logs.debug.push(a.join(' ')),
      warn: (...a) => logs.warn.push(a.join(' ')),
      error: (...a) => logs.error.push(a.join(' ')),
    }),
    './Firewalla.js': { getFirewallaHome: () => '/home/pi/firewalla', '@noCallThru': true },
    'child-process-promise': { execFile: execFileImpl, '@noCallThru': true },
  });
  mod._logs = logs;
  return mod;
}

function modinfoStdout(version, srcversion) {
  return `filename:       /lib/modules/xt_udp_tls.ko\nversion:        ${version}\nsrcversion:     ${srcversion}\ndepends:        \n`;
}

// modinfo output on builds without MODULE_VERSION / CONFIG_MODULE_SRCVERSION_ALL
// (e.g. the aarch64 6.6.104 kernel on orange): neither version: nor srcversion:
function modinfoStdoutNoVersion() {
  return 'filename:       /home/pi/firewalla/platform/orange/files/kernel_modules/6.6.104/xt_udp_tls.ko\n' +
    'alias:          ipt_tls\nlicense:        GPL\ndepends:        x_tables\nname:           xt_udp_tls\n' +
    'vermagic:       6.6.104 SMP mod_unload aarch64\nparm:           max_host_sets:int\n';
}

describe('KernelCrashMonitor', function () {
  this.timeout(5000);

  let fakeRedis;
  beforeEach(function () { fakeRedis = new FakeRedis(); });

  // ── getCrashInfo / readCrashInfo ──────────────────────────────────────────

  describe('getCrashInfo', function () {
    it('returns {} when redis has no entry', async function () {
      const { execFile } = makeExecFile({});
      const kcm = loadKCM(fakeRedis, execFile);
      expect(await kcm.getCrashInfo()).to.deep.equal({});
    });

    it('returns the parsed object when redis has valid JSON', async function () {
      fakeRedis.seed({ crashesCount: 2, shouldDisableUdpTls: true });
      const { execFile } = makeExecFile({});
      const kcm = loadKCM(fakeRedis, execFile);
      expect(await kcm.getCrashInfo()).to.deep.equal({ crashesCount: 2, shouldDisableUdpTls: true });
    });

    it('resets to {} and warns when the stored value is invalid JSON', async function () {
      fakeRedis._store[REDIS_KEY] = '{not json';
      const { execFile } = makeExecFile({});
      const kcm = loadKCM(fakeRedis, execFile);
      const info = await kcm.getCrashInfo();
      expect(info).to.deep.equal({});
      expect(kcm._logs.warn.some(m => m.includes('kernel_crash_info'))).to.be.true;
    });
  });

  // ── shouldDisableUdpTls ────────────────────────────────────────────────────

  // shouldDisableUdpTls() is a synchronous accessor over the in-memory cache;
  // the cache is populated by checkPstoreAndUpdateRedis / onUdpTlsModuleLoaded,
  // not by reading Redis on each call.
  describe('shouldDisableUdpTls', function () {
    it('returns false by default before checkPstoreAndUpdateRedis has run', function () {
      const { execFile } = makeExecFile({});
      const kcm = loadKCM(fakeRedis, execFile);
      expect(kcm.shouldDisableUdpTls()).to.be.false;
    });

    it('returns true after checkPstoreAndUpdateRedis populates the cache from a prior crash-disable', async function () {
      fakeRedis.seed({ shouldDisableUdpTls: true });
      const { execFile } = makeExecFile({ dmesgFindOutput: '' });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect(kcm.shouldDisableUdpTls()).to.be.true;
    });

    it('returns false once onUdpTlsModuleLoaded clears the cache', async function () {
      // stored identity matches the modinfo output below, so the disable stays in effect
      // through checkPstoreAndUpdateRedis and only onUdpTlsModuleLoaded clears it
      fakeRedis.seed({ shouldDisableUdpTls: true, udpModuleVersion: { version: '1.0', srcversion: 'abc', koId: '' } });
      const { execFile } = makeExecFile({ dmesgFindOutput: '', modinfoOutput: modinfoStdout('1.0', 'abc') });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');
      expect(kcm.shouldDisableUdpTls()).to.be.true;

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');
      expect(kcm.shouldDisableUdpTls()).to.be.false;
    });
  });

  // ── onUdpTlsModuleLoaded ───────────────────────────────────────────────────

  describe('onUdpTlsModuleLoaded', function () {
    it('records the module version and clears shouldDisableUdpTls', async function () {
      fakeRedis.seed({ shouldDisableUdpTls: true, udpTlsDisabledOn: 12345 });
      const { execFile } = makeExecFile({ modinfoOutput: modinfoStdout('1.0', 'abc123') });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.udpModuleVersion).to.deep.equal({ version: '1.0', srcversion: 'abc123', koId: '' });
      expect(info.shouldDisableUdpTls).to.be.false;
    });

    it('records the ko id as identity when the .ko carries no version/srcversion', async function () {
      const { execFile, execLog } = makeExecFile({
        modinfoOutput: modinfoStdoutNoVersion(),
        koDescribe: 'id=buildid:deadbeef',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect(execLog).to.include('/home/pi/firewalla/scripts/tls_module_id.sh describe /lib/modules/xt_udp_tls.ko');
      const info = await kcm.getCrashInfo();
      expect(info.udpModuleVersion).to.deep.equal({ version: '', srcversion: '', koId: 'buildid:deadbeef' });
    });

    it('does not record any version when neither the .ko nor modinfo yields one', async function () {
      fakeRedis.seed({ udpModuleVersion: { version: '', srcversion: '', koId: 'buildid:oldhash' } });
      const { execFile } = makeExecFile({ modinfoOutput: modinfoStdoutNoVersion() }); // koDescribe undefined => the .ko yields nothing
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.udpModuleVersion).to.deep.equal({ version: '', srcversion: '', koId: 'buildid:oldhash' });
      expect(info.shouldDisableUdpTls).to.be.false;
    });

    it('records version, srcversion and the build id together when the .ko carries all three', async function () {
      // gse: modinfo refuses xt_udp_tls.ko.<checksum>/.ko.<compiler>, so all three fields come
      // out of the module image instead
      const { execFile } = makeExecFile({
        koDescribe: 'version=0.0.9\nsrcversion=24D95927CCDD39D26C85F3B\nid=buildid:7125e6c7',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls', '/lib/modules/xt_udp_tls.ko.aarch64-none-linux-gnu-gcc');

      expect((await kcm.getCrashInfo()).udpModuleVersion).to.deep.equal({
        version: '0.0.9', srcversion: '24D95927CCDD39D26C85F3B', koId: 'buildid:7125e6c7',
      });
    });

    it('defaults to the module name "xt_udp_tls" when no path is given', async function () {
      const { execFile, execLog } = makeExecFile({ modinfoOutput: modinfoStdout('2.0', 'def456') });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.onUdpTlsModuleLoaded();

      expect(execLog.some(c => c === 'modinfo xt_udp_tls')).to.be.true;
    });

    it('falls back to `modinfo <modName>` when the .ko cannot be described', async function () {
      // koPath does not exist yet (or yields nothing): ask modinfo about the loaded module
      const { execFile, execLog } = makeExecFile({
        modinfoOutput: modinfoStdout('3.0', 'xyz789'), // koDescribe undefined => script fails
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      // tried the .ko first, then fell back to the module name
      expect(execLog).to.include('/home/pi/firewalla/scripts/tls_module_id.sh describe /lib/modules/xt_udp_tls.ko');
      expect(execLog).to.include('modinfo xt_udp_tls');
      const info = await kcm.getCrashInfo();
      expect(info.udpModuleVersion).to.deep.equal({ version: '3.0', srcversion: 'xyz789', koId: '' });
    });

    it('still clears shouldDisableUdpTls when modinfo fails, without clobbering stored version', async function () {
      fakeRedis.seed({ shouldDisableUdpTls: true, udpModuleVersion: { version: '1.0', srcversion: 'abc' } });
      const { execFile } = makeExecFile({ modinfoOutput: null });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls');

      const info = await kcm.getCrashInfo();
      expect(info.udpModuleVersion).to.deep.equal({ version: '1.0', srcversion: 'abc' });
      expect(info.shouldDisableUdpTls).to.be.false;
    });

    it('logs an error and does not throw when redis save fails', async function () {
      const { execFile } = makeExecFile({ modinfoOutput: modinfoStdout('1.0', 'abc') });
      const brokenRedis = {
        getAsync: async () => null,
        setAsync: async () => { throw new Error('redis write failed'); },
      };
      const kcm = loadKCM(brokenRedis, execFile);

      await kcm.onUdpTlsModuleLoaded('xt_udp_tls');
      expect(kcm._logs.error.length).to.equal(1);
    });
  });

  // ── checkPstoreAndUpdateRedis ──────────────────────────────────────────────

  describe('checkPstoreAndUpdateRedis', function () {
    it('does nothing when no dmesg files exist in pstore', async function () {
      const { execFile, execLog } = makeExecFile({ dmesgFindOutput: '' });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.crashesCount).to.be.undefined;
      // monitorStartedAt is always recorded on first run, crash-related fields or not
      expect(info.monitorStartedAt).to.be.a('number').and.above(0);
      expect(execLog.some(c => c.startsWith('sudo cp -a'))).to.be.false;
    });

    it('archives pstore but leaves crash info untouched when no "Kernel panic" is found', async function () {
      const dmesgFindOutput = `100.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile, execLog } = makeExecFile({
        dmesgFindOutput,
        fileContents: { [`${PSTORE_PATH}/dmesg-a`]: 'some unrelated log output' },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.crashesCount).to.be.undefined;
      expect(info.monitorStartedAt).to.be.a('number').and.above(0);
      // still archives to free up pstore space, using the newest dmesg file's ts (100)
      expect(execLog.some(c => c.startsWith(`sudo mkdir -p ${PSTORE_ARCHIVE_PATH}/100`))).to.be.true;
      expect(execLog.some(c => c.includes(`find ${PSTORE_PATH} -mindepth 1 -delete`))).to.be.true;
    });

    it('archives pstore but does not touch crashesCount for a non-udp-tls kernel panic', async function () {
      const dmesgFindOutput = `200.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        fileContents: { [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: ext4 usb_storage' },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.crashesCount).to.be.undefined;
      expect(info.shouldDisableUdpTls).to.be.undefined;
    });

    it('records a udp-tls crash: bumps crashesCount and sets shouldDisableUdpTls', async function () {
      const dmesgFindOutput = `300.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        modinfoOutput: modinfoStdout('1.0', 'abc'),
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.lastCrashTS).to.equal(300);
      expect(info.crashesCount).to.equal(1);
      expect(info.shouldDisableUdpTls).to.be.true;
      expect(info.udpTlsDisabledOn).to.be.a('number').and.above(0);
    });

    it('does NOT disable on first run when a stale pstore crash predates the current (upgraded) module', async function () {
      // first run after an upgrade: no stored crash info, pstore still holds an old
      // udp-tls crash from the previous module, but the .ko was rebuilt/installed later.
      const dmesgFindOutput = `300.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        modinfoOutput: modinfoStdout('2.0', 'new'),
        koMtime: 500, // module installed at ts=500, after the crash at ts=300
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.not.equal(true);
      expect(info.lastCrashTS).to.be.undefined;
      expect(info.crashesCount).to.be.undefined;
    });

    it('DOES disable when the crash is newer than the current module build time', async function () {
      const dmesgFindOutput = `700.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        modinfoOutput: modinfoStdout('2.0', 'new'),
        koMtime: 500, // module installed at ts=500, crash happened later at ts=700
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.true;
      expect(info.lastCrashTS).to.equal(700);
    });

    it('does NOT disable when koPath is a symlink that was re-pointed after the crash', async function () {
      // gse ships xt_udp_tls.ko.aarch64-none-linux-gnu-gcc -> xt_udp_tls.ko.<checksum>: the
      // target keeps its old mtime while the symlink is refreshed, so only the newer of the
      // two shows that the effective module changed after the crash.
      const dmesgFindOutput = `700.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile, execLog } = makeExecFile({
        dmesgFindOutput,
        modinfoOutput: modinfoStdout('2.0', 'new'),
        koMtime: 300,      // target content is older than the crash
        koLinkMtime: 900,  // but the symlink was re-pointed after it
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect(execLog).to.include('stat -L -c %Y /lib/modules/xt_udp_tls.ko');
      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.not.equal(true);
      expect(info.crashesCount).to.be.undefined;
    });

    it('DOES disable when both the symlink and its target predate the crash', async function () {
      const dmesgFindOutput = `700.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        modinfoOutput: modinfoStdout('2.0', 'new'),
        koMtime: 300,
        koLinkMtime: 500,
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.true;
      expect(info.lastCrashTS).to.equal(700);
    });

    it('does not double-count a udp-tls crash that is not newer than the last recorded one', async function () {
      fakeRedis.seed({ lastCrashTS: 500, crashesCount: 1, shouldDisableUdpTls: true });
      const dmesgFindOutput = `500.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.crashesCount).to.equal(1);
      expect(info.lastCrashTS).to.equal(500);
    });

    it('bumps crashesCount again for a newer udp-tls crash', async function () {
      fakeRedis.seed({ lastCrashTS: 100, crashesCount: 1, shouldDisableUdpTls: true });
      const dmesgFindOutput = `600.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.crashesCount).to.equal(2);
      expect(info.lastCrashTS).to.equal(600);
    });

    it('picks the newest dmesg file\'s panic when several are found', async function () {
      const dmesgFindOutput =
        `700.0 ${PSTORE_PATH}/dmesg-old\n` +
        `900.0 ${PSTORE_PATH}/dmesg-new\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        fileContents: {
          [`${PSTORE_PATH}/dmesg-old`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls',
          [`${PSTORE_PATH}/dmesg-new`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls',
        },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect((await kcm.getCrashInfo()).lastCrashTS).to.equal(900);
    });

    it('re-enables UDP TLS when the module version changed after a prior crash-disable', async function () {
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '1.0', srcversion: 'old' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '', // no new crash this run
        modinfoOutput: modinfoStdout('2.0', 'new'),
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

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
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        modinfoOutput: modinfoStdout('1.0', 'same'),
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.true;
    });

    it('re-enables UDP TLS when the ko id changed on a build whose modinfo prints no version', async function () {
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '', srcversion: '', koId: 'buildid:oldhash' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        modinfoOutput: modinfoStdoutNoVersion(),
        koDescribe: 'id=buildid:newhash',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.false;
      expect(info.udpTlsDisabledOn).to.equal(0);
    });

    it('keeps UDP TLS disabled when the ko id is unchanged', async function () {
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '', srcversion: '', koId: 'buildid:samehash' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        modinfoOutput: modinfoStdoutNoVersion(),
        koDescribe: 'id=buildid:samehash',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect((await kcm.getCrashInfo()).shouldDisableUdpTls).to.be.true;
    });

    it('re-enables UDP TLS when the stored record carries no identity at all (pre-koId record)', async function () {
      // a box disabled before the ko-hash fallback existed: modinfo printed nothing, so the
      // stored version is all-empty and could never be compared -> UDP TLS stayed disabled forever
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '', srcversion: '' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        modinfoOutput: modinfoStdoutNoVersion(),
        koDescribe: 'id=buildid:somehash',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.false;
      expect(info.udpTlsDisabledOn).to.equal(0);
    });

    it('re-enables UDP TLS when no version was ever recorded (disabled before any successful load)', async function () {
      // observed on an orange box: {"monitorStartedAt":...,"shouldDisableUdpTls":true} and no
      // udpModuleVersion at all. Nothing would ever record one, since recording happens on a
      // successful load and loading is exactly what the flag disables.
      fakeRedis.seed({ monitorStartedAt: 1783710366, shouldDisableUdpTls: true });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        modinfoOutput: modinfoStdoutNoVersion(),
        koDescribe: 'id=buildid:somehash',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect((await kcm.getCrashInfo()).shouldDisableUdpTls).to.be.false;
      expect(kcm.shouldDisableUdpTls()).to.be.false;
    });

    it('does not re-enable a crash disabled in this same run', async function () {
      // the re-enable check runs against the state read from redis, so a brand new crash
      // (which records no version) must not be undone by the missing-identity rule above
      const dmesgFindOutput = `800.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        modinfoOutput: modinfoStdoutNoVersion(),
        koDescribe: 'id=buildid:somehash',
        koMtime: 500, // crash at 800 is newer than the module
        fileContents: {
          [`${PSTORE_PATH}/dmesg-a`]: 'Kernel panic - not syncing\nModules linked in: xt_udp_tls ext4',
        },
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect((await kcm.getCrashInfo()).shouldDisableUdpTls).to.be.true;
      expect(kcm.shouldDisableUdpTls()).to.be.true;
    });

    it('keeps UDP TLS disabled when a record predating koId still matches on srcversion', async function () {
      // adding koId must not make every stored record read as "changed": with no koId on the
      // stored side the comparison falls back to the strongest field both records carry
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '0.0.9', srcversion: 'SAME' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        koDescribe: 'version=0.0.9\nsrcversion=SAME\nid=buildid:abc',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect((await kcm.getCrashInfo()).shouldDisableUdpTls).to.be.true;
    });

    it('keeps UDP TLS disabled when the stored and current koId are of different types', async function () {
      // a module without a build-id note falls back to srcversion (or sha256) for its koId, so
      // records can hold ids of different types. "srcversion:SAME" vs "buildid:X" is not
      // evidence of a change, and srcversion is what both records can actually be compared on.
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '0.0.9', srcversion: 'SAME', koId: 'srcversion:SAME' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        koDescribe: 'version=0.0.9\nsrcversion=SAME\nid=buildid:X',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect((await kcm.getCrashInfo()).shouldDisableUdpTls).to.be.true;
    });

    it('re-enables UDP TLS when ids of different types come with a changed srcversion', async function () {
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '0.0.9', srcversion: 'OLD', koId: 'sha256:aaa' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        koDescribe: 'version=0.0.9\nsrcversion=NEW\nid=buildid:bbb',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect((await kcm.getCrashInfo()).shouldDisableUdpTls).to.be.false;
    });

    it('re-enables UDP TLS when only the build id changed (same sources, rebuilt module)', async function () {
      // srcversion hashes the sources, so a rebuild with another toolchain keeps it; the build
      // id is what shows the module actually changed
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '0.0.9', srcversion: 'SAME', koId: 'buildid:old' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        koDescribe: 'version=0.0.9\nsrcversion=SAME\nid=buildid:new',
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.false;
      expect(info.udpTlsDisabledOn).to.equal(0);
    });

    it('keeps UDP TLS disabled when the .ko yields no identity at all (corrupt or truncated)', async function () {
      // tls_module_id.sh hands out no id for a file that is not a readable module, so a corrupt
      // .ko must not look like a new module version and clear the crash-safety disable
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '0.0.9', srcversion: 'ABC', koId: 'buildid:X' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        modinfoOutput: null,   // not installed under /lib/modules either
        // koDescribe undefined => the script exits non-zero with no id
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect((await kcm.getCrashInfo()).shouldDisableUdpTls).to.be.true;
      expect(kcm.shouldDisableUdpTls()).to.be.true;
    });

    it('keeps UDP TLS disabled when the current version cannot be determined (module not yet installed)', async function () {
      fakeRedis.seed({
        shouldDisableUdpTls: true,
        udpTlsDisabledOn: 111,
        udpModuleVersion: { version: '1.0', srcversion: 'old' },
      });
      const { execFile } = makeExecFile({
        dmesgFindOutput: '',
        modinfoOutput: null, // koPath doesn't exist yet -> unknown version
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      const info = await kcm.getCrashInfo();
      expect(info.shouldDisableUdpTls).to.be.true;
    });

    it('cleans up old pstore archives, keeping only the most recent ones, before writing the new one', async function () {
      const dmesgFindOutput = `400.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile, execLog } = makeExecFile({
        dmesgFindOutput,
        fileContents: { [`${PSTORE_PATH}/dmesg-a`]: 'no panic here' },
        archiveDirs: ['100', '200', '300'], // 3 existing archives, PSTORE_ARCHIVE_MAX_DIRS=3 keeps 2
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      expect(execLog.some(c => c === `sudo rm -rf ${PSTORE_ARCHIVE_PATH}/100`)).to.be.true;
      expect(execLog.some(c => c === `sudo rm -rf ${PSTORE_ARCHIVE_PATH}/200`)).to.be.false;
      expect(execLog.some(c => c === `sudo rm -rf ${PSTORE_ARCHIVE_PATH}/300`)).to.be.false;
      expect(execLog.some(c => c.startsWith(`sudo mkdir -p ${PSTORE_ARCHIVE_PATH}/400`))).to.be.true;
    });

    it('does not throw when pstore archiving fails', async function () {
      const dmesgFindOutput = `400.0 ${PSTORE_PATH}/dmesg-a\n`;
      const { execFile } = makeExecFile({
        dmesgFindOutput,
        fileContents: { [`${PSTORE_PATH}/dmesg-a`]: 'no panic here' },
        failOn: (cmd) => cmd.startsWith(`sudo mkdir -p ${PSTORE_ARCHIVE_PATH}`),
      });
      const kcm = loadKCM(fakeRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');
      expect(kcm._logs.error.some(m => m.includes('archive/clear pstore'))).to.be.true;
    });

    it('waits for the lock holder and refreshes the cache with the settled decision when it loses the lock', async function () {
      // Redis says "not disabled" at read time; another process holds the lock and
      // is still scanning pstore. This reproduces the FireMain/FireApi startup race.
      fakeRedis.seed({ shouldDisableUdpTls: false });
      const LOCK_KEY = 'kernel_crash_info:lock';
      fakeRedis._store[LOCK_KEY] = 'other-process-token';

      const { execFile } = makeExecFile({ dmesgFindOutput: '' });
      const kcm = loadKCM(fakeRedis, execFile);

      // On the first poll of the wait loop, simulate the lock holder finishing:
      // it records shouldDisableUdpTls=true in Redis and releases the lock.
      const origGet = fakeRedis.getAsync.bind(fakeRedis);
      fakeRedis.getAsync = async (key) => {
        if (key === LOCK_KEY) {
          fakeRedis.seed({ shouldDisableUdpTls: true });
          delete fakeRedis._store[LOCK_KEY];
        }
        return origGet(key);
      };

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');

      // The losing process must observe the winner's decision, not the stale false.
      expect(kcm.shouldDisableUdpTls()).to.be.true;
    });

    it('does not throw when redis is unavailable', async function () {
      const { execFile } = makeExecFile({ dmesgFindOutput: '' });
      const brokenRedis = {
        getAsync: async () => { throw new Error('redis down'); },
        // lock acquisition must still succeed so the failure below is actually exercised
        setAsync: async () => 'OK',
        evalAsync: async () => 0,
      };
      const kcm = loadKCM(brokenRedis, execFile);

      await kcm.checkPstoreAndUpdateRedis('xt_udp_tls', '/lib/modules/xt_udp_tls.ko');
      expect(kcm._logs.error.some(m => m.includes('checkPstoreAndUpdateRedis'))).to.be.true;
    });
  });
});
