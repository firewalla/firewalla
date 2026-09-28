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

const log = require('./logger.js')(__filename);
const f = require('./Firewalla.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const { execFile } = require('child-process-promise');
const uuid = require('uuid');
const { delay } = require('../util/util.js');
const path = require('path');

const REDIS_KEY = "kernel_crash_info";
const LOCK_KEY = "kernel_crash_info:lock";
const LOCK_TTL_SEC = 60;
// how long a lock-losing process waits for the lock holder to finish its pstore
// scan before giving up and refreshing the cache with whatever Redis holds.
const LOCK_WAIT_POLL_MS = 500;
const LOCK_WAIT_TIMEOUT_MS = (LOCK_TTL_SEC + 5) * 1000;
const PSTORE_PATH = "/sys/fs/pstore";
// systemd-pstore.service (enabled by default) harvests /sys/fs/pstore early in boot:
// it moves the records to /var/lib/systemd/pstore and clears pstore (Unlink=yes). When
// it wins that race, /sys/fs/pstore is already empty by the time FireMain/FireApi run,
// so fall back to systemd's archive. Native pstore records are dmesg-<backend>-<n>;
// systemd additionally writes a merged dmesg.txt there, so match dmesg* for its copy.
// Ordered by preference: the live pstore first, systemd's copy only when it is empty.
const SYSTEMD_PSTORE_PATH = "/var/lib/systemd/pstore";
const PSTORE_SOURCES = [
  { path: PSTORE_PATH, glob: "dmesg-*" },
  { path: SYSTEMD_PSTORE_PATH, glob: "dmesg*" },
];
const PSTORE_ARCHIVE_PATH = "/log/system/pstore";
const PSTORE_ARCHIVE_MAX_DIRS = 3;

// Some platforms ship a pstore backend as a module that is never auto-loaded, so crash
// records sit in the backend's storage but never surface under /sys/fs/pstore. The main
// case is efi_pstore on older x86 images: its only autoload alias is the legacy
// platform:efivars device, which modern kernels no longer create, so a crash lands in EFI
// NVRAM and nothing (systemd-pstore or us) ever reads it. When no backend is registered we
// try to load one. ramoops is intentionally excluded - it needs a reserved memory region
// and fails to register without one; the backends worth loading blindly are EFI-only.
const PSTORE_BACKEND_PARAM = "/sys/module/pstore/parameters/backend";
const LOADABLE_PSTORE_BACKENDS = ["efi_pstore"];

// Throwaway variable used to force EFI NVRAM garbage collection after clearing pstore,
// see reclaimEfiNvram. The GUID is ours and arbitrary; efivarfs requires a name-GUID pair.
const EFIVARS_PATH = "/sys/firmware/efi/efivars";
const RECLAIM_PROBE_PATH = `${EFIVARS_PATH}/fwPstoreReclaim-1ac80a2b-5f4e-4a53-9f1e-000000000001`;
// Must stay above efi_pstore's per-record size (psinfo->bufsize, 1024 on every kernel we
// ship - hardcoded up to 5.4, the efi_pstore.record_size param's default and minimum from
// 6.x). A throttled dump stops below record_size + EFI_MIN_RESERVE, and the probe trips
// collection below probe_size + EFI_MIN_RESERVE, so a smaller probe would only fire once
// efi_pstore had already gone silent.
const RECLAIM_PROBE_BYTES = 2048;
// EFI_MIN_RESERVE from arch/x86/platform/efi/quirks.c - the kernel refuses a non-volatile
// write that would leave less than this free, and that refusal is what we work around.
const EFI_MIN_RESERVE = 5120;
// Not reclaiming deleted variables is a firmware bug, not a platform one, and the BIOS
// version is the only thing that tells the affected boxes apart: Gold v1 and Gold v2 both
// report DMI product_name "FirewallaGold" and share platform/gold. Measured by writing an
// 8KB variable and deleting it again - FWGOLDA03 (Gold v1, 2020-01-15) leaves remaining_size
// 8228 bytes lower for good, while FWGOLDB04 (Gold v2), FWGOLDC05 (GoldPlus) and FWGOLDD06
// (GoldPro) all return it immediately, even for a variable deleted from mid-log.
const DMI_BIOS_VERSION_PATH = "/sys/class/dmi/id/bios_version";
const LEAKY_EFI_FIRMWARE = /^FWGOLDA/;
// Before 6.x there is no efivarfs statfs and QueryVariableInfo is reachable from kernel code
// only, so test/kernel_crash/efi_qvi.c samples it into read-only module parameters. Built
// per kernel release and dropped next to xt_udp_tls.ko in
// platform/<platform>/files/kernel_modules/<uname -r>/, which scopes it on its own: only
// Gold v1's 4.15 tree gets one, so Gold v2 (same platform/gold, different kernel release)
// never finds it. Loading it is a query - it writes nothing to NVRAM.
const EFI_QVI_MODULE = "efi_qvi";
const EFI_QVI_REMAINING_PARAM = `/sys/module/${EFI_QVI_MODULE}/parameters/remaining_size`;

// In-memory cache of the "disable UDP TLS" decision so hot-path rule builders
// (Block/TLSSetControl/AdblockPlugin/QuicLogPlugin) can read it synchronously
// without a Redis round-trip. Populated at startup by checkPstoreAndUpdateRedis
// (awaited before module loading in net2/main.js) and refreshed whenever the
// async accessors below run. default to false
let cachedShouldDisableUdpTls = false;

// FireMain and FireApi both call checkPstoreAndUpdateRedis on startup; guard the
// pstore scan/archive/delete with a cross-process redis lock so they don't race.
async function acquireLock(token) {
  const result = await rclient.setAsync(LOCK_KEY, token, 'NX', 'EX', LOCK_TTL_SEC);
  return result === 'OK';
}

async function releaseLock(token) {
  const releaseLockLua = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await rclient.evalAsync(releaseLockLua, 1, LOCK_KEY, token);
  } catch (err) {
    log.warn("Failed to release kernel_crash_info lock:", err.message);
  }
}

// When another process holds the lock, it is the one scanning pstore and may set
// shouldDisableUdpTls after we read Redis. Wait for it to release the lock, then
// re-read kernel_crash_info so our in-memory cache reflects the settled decision
// before rule builders (which read shouldDisableUdpTls synchronously) run.
async function waitForLockReleaseAndRefreshCache() {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(LOCK_WAIT_POLL_MS);
    const holder = await rclient.getAsync(LOCK_KEY).catch(() => null);
    if (!holder)
      break; // lock released (or its TTL expired) — the decision is settled
  }
  const crashInfo = await readCrashInfo().catch((err) => {
    log.error("Error refreshing crash info after waiting for lock:", err.message);
    return {};
  });
  cachedShouldDisableUdpTls = crashInfo.shouldDisableUdpTls === true;
}

// version, srcversion and a type-tagged id ("buildid:..."/"srcversion:..."/"sha256:...") of
// the bundled .ko, read out of the module image by scripts/tls_module_id.sh - shared with
// platform.sh so both write the same values into udpModuleVersion. Returns null when the file
// yields nothing at all.
// Not modinfo(8): the .ko may be compressed, and gse's is xt_udp_tls.ko.<kernel checksum>
// (or a .ko.<compiler> symlink to it), a name modinfo refuses.
async function describeKo(koPath) {
  if (!koPath) return null;
  const script = `${f.getFirewallaHome()}/scripts/tls_module_id.sh`;
  const result = await execFile(script, ['describe', koPath]).catch((err) => {
    log.debug("Failed to describe", koPath, err.message);
    return null;
  });
  if (!result) return null;
  const described = { version: '', srcversion: '', koId: '' };
  for (const line of result.stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.substring(0, idx);
    const value = line.substring(idx + 1).trim();
    if (key === 'version') described.version = value;
    else if (key === 'srcversion') described.srcversion = value;
    else if (key === 'id') described.koId = value;
  }
  return described.koId ? described : null;
}

// What identifies the module we would load: taken from the bundled .ko when we have it, and
// from modinfo about the loaded module when we do not (koPath may not exist yet, or the module
// was loaded by name via modprobe).
// Returns null when no identity at all could be determined (unknown, not "empty").
async function getModuleVersion(modName, koPath) {
  const described = await describeKo(koPath);
  if (described) return described;

  const result = modName && await execFile('modinfo', [modName]).catch((err) => {
    log.debug("Failed to run modinfo for", modName, err.message);
    return null;
  });
  let version = '';
  let srcversion = '';
  for (const line of (result ? result.stdout : '').split('\n')) {
    if (line.startsWith('version:')) {
      version = line.split(':').slice(1).join(':').trim();
    } else if (line.startsWith('srcversion:')) {
      srcversion = line.split(':').slice(1).join(':').trim();
    }
  }
  if (version || srcversion)
    return { version, srcversion, koId: '' };

  log.warn("Failed to get module version for", modName, koPath);
  return null;
}

// version/srcversion/koId, with missing fields normalized to ''
function identityFields(v) {
  if (!v) return null;
  return { version: v.version || '', srcversion: v.srcversion || '', koId: v.koId || '' };
}

function hasIdentity(v) {
  const fields = identityFields(v);
  return !!(fields && (fields.version || fields.srcversion || fields.koId));
}

// type of a tagged id ("buildid:abc" -> "buildid"), '' when it carries no tag
function idType(id) {
  const idx = id.indexOf(':');
  return idx > 0 ? id.substring(0, idx) : '';
}

// Compare on the strongest field both records carry, koId first: it is normally a build id, so
// it also catches a rebuild of unchanged sources, which srcversion (a hash of the sources)
// cannot. Comparing only what both sides have is what keeps a record written before koId
// existed comparable with one written now - demanding equality of all three fields would read
// every stored record as "changed" the first time this runs.
// koId is only compared against an id of the same type: it falls back to srcversion or sha256
// when a module carries no build-id note, so two records can hold ids of different types, and
// "srcversion:ABC" vs "buildid:XYZ" says nothing about whether the module changed (mirrors how
// "same" picks a common id type in scripts/tls_module_id.sh).
function isSameIdentity(a, b) {
  const fa = identityFields(a);
  const fb = identityFields(b);
  if (!fa || !fb) return false;
  if (fa.koId && fb.koId && idType(fa.koId) === idType(fb.koId))
    return fa.koId === fb.koId;
  for (const field of ['srcversion', 'version']) {
    if (fa[field] && fb[field]) return fa[field] === fb[field];
  }
  return false; // nothing comparable in common, so no evidence that they are the same module
}

// mtime (in seconds) of the current xt_udp_tls module file. Used to tell whether a
// pstore crash predates the currently-installed module: an upgrade replaces the .ko
// with a fresh mtime, so a crash older than the .ko belongs to a previous (already
// replaced) module version and must not disable the current one. Returns null when
// the mtime cannot be determined (e.g. koPath does not exist).
// The bundled .ko is often a symlink (e.g. gse's xt_udp_tls.ko.aarch64-none-linux-gnu-gcc
// -> xt_udp_tls.ko.<checksum>), and `stat` reports the symlink's own mtime, not the
// module's. Take the newer of the two: replacing the module content refreshes the target,
// re-pointing the symlink at another build refreshes the link itself.
async function getModuleFileMtimeSec(koPath) {
  if (!koPath) return null;
  const results = await Promise.all([
    execFile('stat', ['-L', '-c', '%Y', koPath]).catch(() => null), // dereferenced (the real .ko)
    execFile('stat', ['-c', '%Y', koPath]).catch(() => null),       // koPath itself, symlink or not
  ]);
  const secs = results
    .map((r) => r && parseInt(r.stdout.trim(), 10))
    .filter((sec) => Number.isFinite(sec));
  return secs.length ? Math.max(...secs) : null;
}

async function readCrashInfo() {
  const raw = await rclient.getAsync(REDIS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    log.warn("Failed to parse kernel_crash_info, resetting:", e.message);
    return {};
  }
}

async function saveCrashInfo(info) {
  await rclient.setAsync(REDIS_KEY, JSON.stringify(info));
}

// keep at most PSTORE_ARCHIVE_MAX_DIRS-1 previous archives so the new one always fits
async function cleanupOldPstoreArchives() {
  const result = await execFile('ls', ['-1', PSTORE_ARCHIVE_PATH]).catch(() => ({ stdout: '' }));
  const dirs = result.stdout.trim().split('\n').filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));
  const toRemove = dirs.slice(0, Math.max(0, dirs.length - (PSTORE_ARCHIVE_MAX_DIRS - 1)));
  for (const dir of toRemove) {
    await execFile('sudo', ['rm', '-rf', `${PSTORE_ARCHIVE_PATH}/${dir}`]).catch((err) => {
      log.error(`Failed to remove old pstore archive ${dir}:`, err.message);
    });
  }
}

// copy crash records from sourcePath to PSTORE_ARCHIVE_PATH for later inspection, then
// clear sourcePath so space is freed for the next crash. Unlinking files in /sys/fs/pstore
// releases the records in the underlying persistent ram/flash backend; clearing systemd's
// archive stops us from re-detecting the same crash on every subsequent boot (its files
// otherwise linger).
// On EFI, releasing a record is not the same as getting the space back - the firmware only
// marks it dead. reclaimEfiNvram() below has to run afterwards to make the space usable
// again.
// Returns true only when the records were actually unlinked, which is what lets the caller
// run the EFI reclaim exactly once per crash: once they are gone a later pass finds nothing.
async function archiveAndClearPstore(sourcePath, crashTS) {
  try {
    await execFile('sudo', ['mkdir', '-p', PSTORE_ARCHIVE_PATH]);
    await cleanupOldPstoreArchives();

    const archiveDir = `${PSTORE_ARCHIVE_PATH}/${crashTS}`;
    await execFile('sudo', ['mkdir', '-p', archiveDir]);
    await execFile('sudo', ['cp', '-a', `${sourcePath}/.`, `${archiveDir}/`]);
    log.info(`Archived pstore files from ${sourcePath} to ${archiveDir}`);

    await execFile('sudo', ['find', sourcePath, '-mindepth', '1', '-delete']);
    log.info(`Cleared ${sourcePath} after archiving`);
    return true;
  } catch (err) {
    log.error("Failed to archive/clear pstore:", err.message);
    return false;
  }
}

// The registered pstore backend name, '' when none ("(null)" on a kernel with no backend).
async function currentPstoreBackend() {
  const r = await execFile('sudo', ['cat', PSTORE_BACKEND_PARAM]).catch(() => ({ stdout: '' }));
  const v = (r.stdout || '').trim();
  return (v === '(null)' || v === 'null') ? '' : v;
}

// Free bytes in the EFI variable store, or null when the kernel will not say. efivarfs only
// grew a real statfs (backed by QueryVariableInfo) in 6.x; before that it is simple_statfs
// and reports zero blocks. Reading costs nothing - no flash write - so where it works it
// lets us skip the probe entirely.
// Whether this box's firmware is one of the versions measured never to give the space back.
// Only consulted when the free space cannot be read, see reclaimEfiNvram.
async function hasLeakyEfiFirmware() {
  const r = await execFile('cat', [DMI_BIOS_VERSION_PATH]).catch(() => null);
  return !!r && LEAKY_EFI_FIRMWARE.test(r.stdout.trim());
}

async function efivarsFreeBytesViaStatfs() {
  const r = await execFile('stat', ['-f', '-c', '%s %b %f', EFIVARS_PATH]).catch(() => null);
  if (!r) return null;
  const [bsize, blocks, free] = r.stdout.trim().split(/\s+/).map(Number);
  if (![bsize, blocks, free].every(Number.isFinite) || !blocks) return null;
  return bsize * free;
}

// Same number from efi_qvi, for the kernels statfs cannot answer on. koPath is the bundled
// xt_udp_tls.ko; efi_qvi.ko sits in the same per-kernel-release directory, so no platform
// lookup is needed. Returns null whenever the module is absent or will not load, and the
// caller then falls back to the firmware list. The module is removed first so the sample is
// always fresh rather than whatever a previous run left cached in its parameters.
async function efivarsFreeBytesViaModule(koPath) {
  if (!koPath) return null;
  const qviPath = `${path.dirname(koPath)}/${EFI_QVI_MODULE}.ko`;
  const present = await execFile('test', ['-f', qviPath]).then(() => true).catch(() => false);
  if (!present) return null;

  await execFile('sudo', ['rmmod', EFI_QVI_MODULE]).catch(() => {});
  try {
    await execFile('sudo', ['insmod', qviPath]);
  } catch (err) {
    log.warn(`Failed to load ${EFI_QVI_MODULE}, falling back to the firmware list:`, err.message);
    return null;
  }
  try {
    const r = await execFile('cat', [EFI_QVI_REMAINING_PARAM]);
    const free = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(free) ? free : null;
  } catch (err) {
    log.warn(`Failed to read ${EFI_QVI_REMAINING_PARAM}:`, err.message);
    return null;
  } finally {
    await execFile('sudo', ['rmmod', EFI_QVI_MODULE]).catch(() => {});
  }
}

// Free bytes in the EFI variable store, or null when neither route can tell us. Reading
// costs nothing - no flash write - so where it works the probe below is spent only when it
// is guaranteed to trip collection rather than merely consume space.
async function efivarsFreeBytes(koPath) {
  const viaStatfs = await efivarsFreeBytesViaStatfs();
  if (viaStatfs !== null) return viaStatfs;
  return efivarsFreeBytesViaModule(koPath);
}

// EFI NVRAM is an append-only log: deleting a variable only marks its record dead, and the
// firmware reclaims that space only during a garbage collection pass it runs when a
// SetVariable does not fit. A panic never gets that far - efi_pstore writes through
// query_variable_store_nonblocking() (arch/x86/platform/efi/quirks.c), which refuses the
// write once remaining_size - size drops below EFI_MIN_RESERVE and deliberately skips
// collection because it runs from a crash handler. So on firmware that does not reclaim on
// delete (measured on Gold v1 / BIOS FWGOLDA03: one crash = two kmsg_dump events x
// kmsg_bytes, 22779 bytes, never returned) efi-pstore stops recording after ~4 crashes, and
// does so silently because pstore_dump() ignores the backend's write() return value.
//
// A userspace efivarfs write takes the *blocking* branch, which forces the collection by
// writing an oversized dummy variable and then re-querying. So write one throwaway variable
// here and delete it again. On firmware that does reclaim on delete (every Gold BIOS after
// A03, and the arm boxes have no EFI at all) this costs nothing at all.
// Note the efi_no_storage_paranoia boot parameter does NOT help: it is only tested in the
// blocking branch, never in query_variable_store_nonblocking().
//
// Known limitation on kernels without efivarfs statfs: when the write does not trip
// collection it still costs its own size on leaky firmware, which can leave the store just
// under what efi_pstore needs for one record, and the next panic then records nothing. It
// cannot be designed away - the probe has to be larger than a pstore record to fire in
// time, so it always consumes more than the margin it protects - and the outcome is a
// degraded new feature rather than a regression: before efi_pstore was enabled here the box
// recorded nothing either.
async function reclaimEfiNvram(koPath) {
  // efi_pstore_info.name is "efi" up to 5.4 and KBUILD_MODNAME ("efi_pstore") from 6.x, so
  // match the prefix - an exact "efi" test silently skips GoldPlus/GoldPro. Every other
  // backend (ramoops on the arm boxes, none at all) has nothing to reclaim.
  if (!/^efi/.test(await currentPstoreBackend())) return;
  const hasEfivars = await execFile('test', ['-d', EFIVARS_PATH]).then(() => true).catch(() => false);
  if (!hasEfivars) return;

  const freeBytes = await efivarsFreeBytes(koPath);
  if (freeBytes !== null) {
    // The exact answer: write only when the write would actually trip collection. Correct
    // on any firmware, so no version check belongs here - if a BIOS we believe to be fine
    // ever does start leaking, this path still handles it.
    if (freeBytes - RECLAIM_PROBE_BYTES >= EFI_MIN_RESERVE) {
      log.info(`EFI variable store has ${freeBytes} bytes free, no reclaim needed`);
      return;
    }
    log.info(`EFI variable store down to ${freeBytes} bytes free, forcing a reclaim`);
  } else if (!await hasLeakyEfiFirmware()) {
    // Flying blind, so spend a write only on firmware known not to collect on its own.
    // Every kernel from 6.x implements efivarfs statfs and takes the branch above, so this
    // one is legacy-only (Gold v1 on 4.15, Gold v2 on 5.4) and will not need new entries.
    log.info("EFI variable store free space is unreadable and this firmware reclaims on delete, skipping");
    return;
  }

  // efivarfs wants the 4-byte attribute word (NON_VOLATILE|BOOTSERVICE_ACCESS|RUNTIME_ACCESS)
  // and the payload in a single write(2); iflag=fullblock makes dd assemble the whole block
  // before writing it. Variables are created immutable, so chattr -i precedes every rm.
  const cleanup = `chattr -i '${RECLAIM_PROBE_PATH}' 2>/dev/null; rm -f '${RECLAIM_PROBE_PATH}'`;
  const write = `${cleanup}; { printf '\\x07\\x00\\x00\\x00'; head -c ${RECLAIM_PROBE_BYTES} /dev/zero; } | ` +
    `dd of='${RECLAIM_PROBE_PATH}' bs=${RECLAIM_PROBE_BYTES + 4} count=1 iflag=fullblock status=none`;
  try {
    await execFile('sudo', ['bash', '-c', write]);
    log.info("EFI NVRAM reclaim probe accepted; variable store can still take a crash dump");
  } catch (err) {
    // ENOSPC ("No space left on device") means the firmware had nothing left to collect, so
    // efi_pstore cannot record the next panic and the UDP TLS kill switch is effectively off
    log.error("EFI variable store is exhausted, kernel crash records will be lost:", err.message);
  } finally {
    await execFile('sudo', ['bash', '-c', cleanup]).catch(() => {});
  }
}

// When no pstore backend is registered, load one so any crash the box just took becomes
// visible under /sys/fs/pstore before we scan. This runs at FireMain/FireApi startup, long
// after systemd-pstore's boot-time oneshot has already given up on an empty pstore, so once
// we load the module the records are ours to read directly (and archiveAndClearPstore then
// releases the backend's records - unlinking the EFI variables - as usual).
async function ensurePstoreBackendLoaded() {
  const backend = await currentPstoreBackend();
  if (backend) {
    log.debug(`pstore backend already registered: ${backend}`);
    return;
  }
  const isEfi = await execFile('test', ['-d', '/sys/firmware/efi']).then(() => true).catch(() => false);
  for (const mod of LOADABLE_PSTORE_BACKENDS) {
    if (mod === 'efi_pstore' && !isEfi) continue;
    const loaded = await execFile('sudo', ['modprobe', mod])
      .then(() => true)
      .catch((err) => { log.debug(`modprobe ${mod} failed:`, err.message); return false; });
    if (!loaded) continue;
    const now = await currentPstoreBackend();
    if (now) {
      log.info(`Loaded pstore backend module ${mod}; backend now '${now}'`);
      return;
    }
    log.warn(`Loaded ${mod} but no pstore backend registered (module may be disabled)`);
  }
}

// Return the first pstore source that actually holds crash records, with its dmesg files
// as "%T@ %p" lines sorted newest-first. With systemd-pstore's default Unlink=yes only one
// source is ever populated: the live pstore when we reach it first, or systemd's copy once
// it has harvested. A source directory that does not exist (systemd's, on boxes without the
// service) makes find fail and is skipped.
async function findPstoreSource() {
  for (const source of PSTORE_SOURCES) {
    const findResult = await execFile('sudo',
      ['find', source.path, '-name', source.glob, '-type', 'f', '-printf', '%T@ %p\n']
    ).catch((err) => ({ stdout: (err && err.stdout) || '' }));
    const lines = findResult.stdout.trim().split('\n').filter(Boolean)
      .sort((a, b) => parseFloat(b) - parseFloat(a));
    if (lines.length)
      return { sourcePath: source.path, lines };
  }
  return { sourcePath: null, lines: [] };
}

// Called at FireMain and FireApi startup. modName is the module name (e.g. "xt_udp_tls")
// and koPath is the path to xt_udp_tls.ko (may not exist yet).
async function checkPstoreAndUpdateRedis(modName, koPath) {
  const crashInfo = await readCrashInfo().catch((err) => {
    log.error("Error in checkPstoreAndUpdateRedis reading crash info:", err.message);
    return {};
  });
  cachedShouldDisableUdpTls = crashInfo.shouldDisableUdpTls === true;
  const token = uuid.v4();
  if (!await acquireLock(token).catch((err) => {
    log.error("Failed to acquire kernel_crash_info lock:", err.message);
    return false;
  })) {
    log.info("Another process is already checking pstore, waiting for it to finish before refreshing cache");
    await waitForLockReleaseAndRefreshCache();
    return;
  }
  try {
    // On platforms whose pstore backend is a module that never auto-loads (efi_pstore on
    // some x86 images), load it first so a just-taken crash surfaces under /sys/fs/pstore.
    await ensurePstoreBackendLoaded();
    // dmesg pstore files, newest first, from the live pstore or - if systemd-pstore
    // already harvested it - from systemd's archive (see PSTORE_SOURCES).
    const { sourcePath, lines } = await findPstoreSource();

    const currentVersion = await getModuleVersion(modName, koPath).catch(() => null);
    const storedVersion = crashInfo.udpModuleVersion;
    let updateCrashInfoNeed = false;
    let dumpPstoreNeeded = false;
    let latestCrashTSSec;
    // only treat the version as "known different" when we could actually read the
    // current module's version; koPath may not exist yet (see comment above), and an
    // unknown version must not be confused with a confirmed version change.
    // A missing stored record, or one with no usable identity (written before the ko-hash
    // fallback existed, on a build whose modinfo prints no version), cannot be compared
    // against. Treat that as changed once we can identify the current module, otherwise
    // such a box stays disabled forever: nothing else ever records an identity for it,
    // because recording only happens on a successful load and loading is what is disabled.
    // If the module really is still broken it crashes again, and by then the identity is
    // recorded and the disable sticks.
    const isVersionKnownDifferent = !!(currentVersion &&
      (!hasIdentity(storedVersion) || !isSameIdentity(currentVersion, storedVersion)));

    if (crashInfo.shouldDisableUdpTls) {
      if (isVersionKnownDifferent) {
        log.info("UDP TLS was disabled due to a previous crash, but module version has changed. Re-enabling UDP TLS.");
        crashInfo.shouldDisableUdpTls = false;
        crashInfo.udpTlsDisabledOn = 0;
        updateCrashInfoNeed = true;
      } else {
        log.warn("UDP TLS is currently disabled due to a previous crash. Not attempting to load xt_udp_tls.");
      }
    }


    if (lines.length === 0) {
      log.debug("No recent pstore crash files found");
    } else {
      dumpPstoreNeeded = true;
      // pstore may split a single crash's dmesg across several files, so "Kernel panic"
      // and "Modules linked in:...xt_udp_tls" are not guaranteed to land in the same file.
      // Stream all recent files through grep instead of reading (and requiring sudo for)
      // each file's content into memory individually.
      const tsByPath = new Map();
      for (const line of lines) {
        const spaceIdx = line.indexOf(' ');
        tsByPath.set(line.substring(spaceIdx + 1).trim(), parseFloat(line.substring(0, spaceIdx)));
      }
      const paths = [...tsByPath.keys()];
      // default archive timestamp: newest dmesg file overall, used when none of them
      // matched "Kernel panic" below (still archived so pstore space is freed up)
      latestCrashTSSec = Math.round(Math.max(...tsByPath.values()));

      // treat both a "Kernel panic" and an "Oops" in pstore as a kernel crash
      const panicFiles = await execFile('sudo', ['grep', '-l', '-e', 'Kernel panic', '-e', 'Oops', ...paths])
        .then(r => r.stdout.trim().split('\n').filter(Boolean))
        .catch(() => []);

      if (panicFiles.length === 0) {
        log.debug("No Kernel panic or Oops found in recent pstore files");
      } else {
        latestCrashTSSec = Math.round(Math.max(...panicFiles.map(p => tsByPath.get(p) || 0)));

        // pull the concatenated content and test in JS instead of piping through a second grep
        const isUdpTlsCrash = await execFile('sudo', ['cat', ...paths])
          .catch((err) => ({ stdout: (err && err.stdout) || '' }))
          .then(r => /Modules linked in:.*xt_udp_tls/.test(r.stdout));

        log.warn(`Kernel panic detected in pstore, ts=${latestCrashTSSec}, udpTlsRelated=${isUdpTlsCrash}`);

        // ignore crashes that predate the currently-installed module: on the first run
        // after an upgrade, pstore may still hold a crash from a previous (already fixed)
        // module version. The version-change guard above can't catch this because there is
        // no stored udpModuleVersion to compare against yet, so fall back to the module
        // file's build/install time.
        const koMtimeSec = await getModuleFileMtimeSec(koPath).catch(() => null);
        const crashPredatesCurrentModule = koMtimeSec !== null && latestCrashTSSec < koMtimeSec;

        if (isUdpTlsCrash && crashPredatesCurrentModule) {
          log.info(`UDP TLS crash (ts=${latestCrashTSSec}) predates current module build time (${koMtimeSec}); module has been upgraded since, not disabling UDP TLS.`);
        } else if (isUdpTlsCrash) {
          if (!crashInfo.lastCrashTS || latestCrashTSSec > crashInfo.lastCrashTS) {
            crashInfo.lastCrashTS = latestCrashTSSec;
            crashInfo.crashesCount = (crashInfo.crashesCount || 0) + 1;

            crashInfo.shouldDisableUdpTls = true;
            crashInfo.udpTlsDisabledOn = Math.round(Date.now() / 1000);
            const versionInfo = currentVersion ? ` (module version ${currentVersion.version}/${currentVersion.srcversion}/${currentVersion.koId})` : '';
            log.warn(`UDP TLS crash detected${versionInfo}, disabling UDP TLS`);
            updateCrashInfoNeed = true;
          } else {
            log.debug("Pstore crash is not newer than last recorded crash");
          }
        }

      }
    }
        
    if (!crashInfo.monitorStartedAt) {
      crashInfo.monitorStartedAt = Math.round(Date.now() / 1000);
      updateCrashInfoNeed = true;
    }


    cachedShouldDisableUdpTls = crashInfo.shouldDisableUdpTls === true;
    log.debug("Updated kernel_crash_info in Redis:", JSON.stringify(crashInfo));
    if (updateCrashInfoNeed) {
      await saveCrashInfo(crashInfo);
    }

    // Preserve the crash logs and free up pstore space for the next crash, then - on EFI -
    // make the firmware actually reclaim that space, because unlinking the records only
    // marks them dead (see reclaimEfiNvram).
    //
    // Chained on the archive succeeding, which gives three things at once: the records are
    // gone before collection runs (collecting earlier would reclaim nothing), a box that
    // never panics writes nothing to NVRAM at all, and a FireMain restart cannot repeat the
    // write because the second pass finds pstore empty. efi_pstore is newly enabled on these
    // boxes - before it nothing wrote to the EFI variable store - so every byte here is a
    // cost this feature introduces, and tying it to a dump that just spent ~22KB keeps it at
    // roughly 9% on top of a cost already accepted.
    if (dumpPstoreNeeded && await archiveAndClearPstore(sourcePath, latestCrashTSSec))
      await reclaimEfiNvram(koPath);
  } catch (err) {
    log.error("Error in checkPstoreAndUpdateRedis:", err.message);
  } finally {
    await releaseLock(token);
  }
}

// Returns true if UDP TLS should be disabled due to a previous crash, false otherwise.
// checkPstoreAndUpdateRedis must be called first to populate the in-memory cache (awaited before module loading in net2/main.js).
function shouldDisableUdpTls() {
  return cachedShouldDisableUdpTls;
}

// Called by Platform.installTLSModule after xt_udp_tls is successfully loaded.
// modName is the module name (e.g. "xt_udp_tls"); koPath is the .ko file path if
// insmod was used (may be null when loaded by name).
async function onUdpTlsModuleLoaded(modName, koPath) {
  try {
    const version = await getModuleVersion(modName || 'xt_udp_tls', koPath);
    const crashInfo = await readCrashInfo();

    if (version) {
      crashInfo.udpModuleVersion = version;
    }
    // record when this load happened (udpTlsDisabledOn in struct corresponds to disabled state;
    // reset shouldDisableUdpTls since the module just loaded successfully)
    crashInfo.shouldDisableUdpTls = false;
    cachedShouldDisableUdpTls = false;

    await saveCrashInfo(crashInfo);
    log.info("Updated udpModuleVersion after successful xt_udp_tls load:", JSON.stringify(version));
  } catch (err) {
    log.error("Failed to update udpModuleVersion after module load:", err.message);
  }
}

module.exports = {
  checkPstoreAndUpdateRedis,
  shouldDisableUdpTls,
  onUdpTlsModuleLoaded,
  getCrashInfo: readCrashInfo,
};
