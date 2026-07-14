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
const rclient = require('../util/redis_manager.js').getRedisClient();
const { execFile } = require('child-process-promise');
const uuid = require('uuid');

const REDIS_KEY = "kernel_crash_info";
const LOCK_KEY = "kernel_crash_info:lock";
const LOCK_TTL_SEC = 60;
const PSTORE_PATH = "/sys/fs/pstore";
const PSTORE_ARCHIVE_PATH = "/log/system/pstore";
const PSTORE_ARCHIVE_MAX_DIRS = 3;

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

// parse "version:" and "srcversion:" lines from modinfo output
async function getModuleVersion(koPathOrName) {
  const result = await execFile('modinfo', [koPathOrName]).catch((err) => {
    log.error("Failed to run modinfo for", koPathOrName, err.message);
    return null;
  });
  if (!result) return null;

  let version = '';
  let srcversion = '';
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('version:')) {
      version = line.split(':').slice(1).join(':').trim();
    } else if (line.startsWith('srcversion:')) {
      srcversion = line.split(':').slice(1).join(':').trim();
    }
  }
  return { version, srcversion };
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

// copy pstore contents to PSTORE_ARCHIVE_PATH for later inspection, then clear pstore
// (unlinking files in pstore frees the underlying persistent ram/flash backend) so
// space is available for the next crash.
async function archiveAndClearPstore(crashTS) {
  try {
    await execFile('sudo', ['mkdir', '-p', PSTORE_ARCHIVE_PATH]);
    await cleanupOldPstoreArchives();

    const archiveDir = `${PSTORE_ARCHIVE_PATH}/${crashTS}`;
    await execFile('sudo', ['mkdir', '-p', archiveDir]);
    await execFile('sudo', ['cp', '-a', `${PSTORE_PATH}/.`, `${archiveDir}/`]);
    log.info(`Archived pstore files to ${archiveDir}`);

    await execFile('sudo', ['find', PSTORE_PATH, '-mindepth', '1', '-delete']);
    log.info("Cleared pstore directory after archiving");
  } catch (err) {
    log.error("Failed to archive/clear pstore:", err.message);
  }
}

// Called at FireMain and FireApi startup. koPath is the path to xt_udp_tls.ko (may not exist yet).
async function checkPstoreAndUpdateRedis(koPath) {
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
    log.info("Another process is already checking pstore, skipping");
    return;
  }
  try {
    // find dmesg-* pstore files, sorted newest first (mirrors `| sort -rn` on the printf'd mtime)
    const findResult = await execFile('sudo',
      ['find', PSTORE_PATH, '-name', 'dmesg-*', '-type', 'f', '-printf', '%T@ %p\n']
    ).catch((err) => ({ stdout: (err && err.stdout) || '' }));

    const lines = findResult.stdout.trim().split('\n').filter(Boolean)
      .sort((a, b) => parseFloat(b) - parseFloat(a));

    const currentVersion = await getModuleVersion(koPath).catch(() => null);
    const storedVersion = crashInfo.udpModuleVersion;
    let updateCrashInfoNeed = false;
    let dumpPstoreNeeded = false;
    let latestCrashTSSec;
    // only treat the version as "known different" when we could actually read the
    // current module's version; koPath may not exist yet (see comment above), and an
    // unknown version must not be confused with a confirmed version change.
    const isVersionKnownDifferent = !!(currentVersion && storedVersion &&
      (currentVersion.version !== storedVersion.version ||
       currentVersion.srcversion !== storedVersion.srcversion));

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

      const panicFiles = await execFile('sudo', ['grep', '-l', 'Kernel panic', ...paths])
        .then(r => r.stdout.trim().split('\n').filter(Boolean))
        .catch(() => []);

      if (panicFiles.length === 0) {
        log.debug("No Kernel panic found in recent pstore files");
      } else {
        latestCrashTSSec = Math.round(Math.max(...panicFiles.map(p => tsByPath.get(p) || 0)));

        // pull the concatenated content and test in JS instead of piping through a second grep
        const isUdpTlsCrash = await execFile('sudo', ['cat', ...paths])
          .catch((err) => ({ stdout: (err && err.stdout) || '' }))
          .then(r => /Modules linked in:.*xt_udp_tls/.test(r.stdout));

        log.warn(`Kernel panic detected in pstore, ts=${latestCrashTSSec}, udpTlsRelated=${isUdpTlsCrash}`);

        if (isUdpTlsCrash) {
          if (!crashInfo.lastCrashTS || latestCrashTSSec > crashInfo.lastCrashTS) {
            crashInfo.lastCrashTS = latestCrashTSSec;
            crashInfo.crashesCount = (crashInfo.crashesCount || 0) + 1;

            crashInfo.shouldDisableUdpTls = true;
            crashInfo.udpTlsDisabledOn = Math.round(Date.now() / 1000);
            const versionInfo = currentVersion ? ` (module version ${currentVersion.version}/${currentVersion.srcversion})` : '';
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

    // preserve the crash logs and free up pstore space for the next crash
    if (dumpPstoreNeeded)
      await archiveAndClearPstore(latestCrashTSSec);
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
// koPath is the .ko file path if insmod was used, otherwise pass the module name.
async function onUdpTlsModuleLoaded(koPathOrName) {
  try {
    const version = await getModuleVersion(koPathOrName || 'xt_udp_tls');
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
