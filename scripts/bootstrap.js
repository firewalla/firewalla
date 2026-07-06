'use strict';

// Box activation bootstrap — onboard (unattended) mode only.
//
// Reads ~/.firewalla/onboard-config.json and runs in two phases:
//   Phase 1 (unconditional on boot): install license -> ~/.firewalla/license + bootingComplete=1
//                                    (usable as soon as it's installed)
//   Phase 2 (only if msp/app was selected AND the user clicked activate in the MSP web UI):
//       register(bid) -> poll rendezvous until activate -> join MSP / join App
//
// Fully silent: this script only console.log's structured logs, which fireonboard.sh redirects to
// ~/.firewalla/fireonboard.log; nothing is shown on the user's console.
//
// Network + sshd are already applied by fireonboard.sh before this runs (FireRouter); not handled here.
// The default password (firewalla) is set during install (flash.sh chroot), unrelated to this script.

const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const fs = require('fs');
const uuid = require('uuid');
const rp = require('request-promise');
const _ = require('lodash');

const Cloud = require('../encipher');
const rclient = require('../util/redis_manager.js').getRedisClient();
const licenseUtil = require('../util/license.js');
const bone = require('../lib/Bone.js');
const networkTool = require('../net2/NetworkTool.js')();

const CONFIG_FILE = process.env.FW_CONFIG || '/encipher.config/netbot.config';
const PROVISION_BASE = process.env.FW_PROVISION_BASE || 'https://msp.dd.firewalla.net';
const BOOTSTRAP_PATH = '/vmbox/bootstrap';
// onboard-config.json: baked into the image at build time (see onboard-config.sample.json).
const ONBOARD_CONFIG = process.env.FW_ONBOARD_CONFIG || '/home/pi/.firewalla/onboard-config.json';
// Box-local fireapi: add the phone App user as a peer of the box (join App management).
const LOCAL_ENCIPHER_API = process.env.FW_LOCAL_ENCIPHER_API
  || 'http://localhost:8834/v1/encipher/simple?command=cmd&item=addPeers';

// Poll interval: kept long to lower CPU further (CPU use is already tiny, ~8s/hour measured).
const POLL_INTERVAL_SEC = 5;
// No timeout: keep polling until the user clicks activate in the MSP web UI (see waitForInvitation).

let eptcloud;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log(`[onboard ${new Date().toISOString()}] ${msg}`);

// ── config ─────────────────────────────────────────────────────────────────────

// Read onboard-config. Returns null on missing/parse failure (=> main aborts).
function loadOnboardConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ONBOARD_CONFIG, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch (e) {
    return null;
  }
}

// netbot.config: appId/appSecret used for the encipher login.
function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  for (const k of ['appId', 'appSecret']) {
    if (!cfg[k]) throw new Error(`${CONFIG_FILE} missing field: ${k}`);
  }
  return cfg;
}

// ── cloud / activation primitives ────────────────────────────────────────────────

async function connectCloud(config) {
  eptcloud = new Cloud(config.endpoint_name || 'netbot', null);
  await eptcloud.loadKeys();
  await eptcloud.eptLogin(config.appId, config.appSecret, null, config.endpoint_name);
}

// gid is generated on the fly by firekick and written to sys:ept.gid; wait for it defensively.
async function waitForGid(maxSec = 10) {
  for (let i = 0; i < maxSec; i++) {
    const gid = await rclient.hgetAsync('sys:ept', 'gid');
    if (gid) return gid;
    await sleep(1000);
  }
  throw new Error('sys:ept.gid not found - firekick must run first');
}

async function registerBootstrap({ bootstrapId, rid, gid }) {
  await rp({
    uri: `${PROVISION_BASE}${BOOTSTRAP_PATH}`,
    method: 'POST',
    json: true,
    body: { bootstrap_id: bootstrapId, rid, gid },
    timeout: 15000
  });
}

// Poll encipher rendezvous until the user clicks activate in the MSP web UI and the backend pushes
// the payload. Returns { value: <web_eid>, evalue: JSON({ license, server, business }) }.
async function waitForInvitation(rid) {
  // No timeout: poll until the user clicks activate and the backend pushes the payload.
  // Log a heartbeat every ~5 min so a long quiet fireonboard.log doesn't look stuck.
  let i = 0;
  const heartbeatEvery = Math.max(1, Math.round(300 / POLL_INTERVAL_SEC));
  for (;;) {
    try {
      const res = await eptcloud.rendezvousMap(rid);
      if (res && res.value) return res;
    } catch (e) {
      if (e.statusCode !== 404) log(`poll error: ${e.message}`);
    }
    if (++i % heartbeatEvery === 0) {
      log(`still waiting for activate... (${i * POLL_INTERVAL_SEC}s elapsed)`);
    }
    await sleep(POLL_INTERVAL_SEC * 1000);
  }
}

function parsePayload(evalue) {
  if (!evalue) throw new Error('evalue missing');
  const payload = typeof evalue === 'string' ? JSON.parse(evalue) : evalue;
  if (!payload.server)   throw new Error('payload.server missing');
  if (!payload.business) throw new Error('payload.business missing');
  return payload;
}

// Fetch the full signed license from the cloud (bound to this box's MAC) and write ~/.firewalla/license.
async function installLicense(licenseUuid, mac) {
  await bone.waitUntilCloudReadyAsync();
  const license = await bone.getLicenseAsync(licenseUuid, mac);
  if (!license || !license.DATA || !license.DATA.UUID) {
    throw new Error(`license fetch failed for ${licenseUuid}`);
  }
  await licenseUtil.writeLicenseAsync(license);
  return license;
}

// Install license + mark bootingComplete + record state. source is for logging only (msp-payload / onboard-config).
async function installLicenseAndMark(licenseUuid, mac, source) {
  log(`installing license ${licenseUuid} (from ${source})`);
  const license = await installLicense(licenseUuid, mac);
  await markBootingComplete();
  await persistState({
    stage: 'licensed',
    license_uuid: license.DATA.UUID,
    license_type: license.DATA.LICENSE,
    bound_mac: license.DATA.MAC,
    license_source: source,
    licensed_at: new Date().toISOString(),
  });
  log(`license installed uuid=${license.DATA.UUID} type=${license.DATA.LICENSE}`);
  return license;
}

async function joinWebEidToGroup(gid, webEid) {
  let findResult = await eptcloud.groupFind(gid);
  const already = _.get(findResult, 'group.symmetricKeys', []).some(k => k.eid === webEid);
  if (!already) {
    await eptcloud.eptInviteGroup(gid, webEid);
    findResult = await eptcloud.groupFind(gid);
  }
  const count = _.get(findResult, 'group.symmetricKeys.length', 0);
  if (count < 2) {
    throw new Error(`expected group_member_cnt > 1 after invite, got ${count}`);
  }
  await rclient.hsetAsync('sys:ept', 'group_member_cnt', count);
  return count;
}

async function writeUiConf(gid) {
  await fs.promises.writeFile('/home/pi/.firewalla/ui.conf', JSON.stringify({ gid }), 'utf8');
}

async function configureGuardian({ server, region, business }) {
  await rclient.setAsync('ext.guardian.socketio.server', server);
  if (region) await rclient.setAsync('ext.guardian.socketio.region', region);
  await rclient.setAsync('ext.guardian.socketio.adminStatus', '1');
  await rclient.setAsync('ext.guardian.business', JSON.stringify(business));
}

async function markBootingComplete() {
  await rclient.setAsync('bootingComplete', '1');
}

async function restartFireApi() {
  await execAsync('sudo systemctl restart fireapi');
}

// Add the phone App user's eid as a peer of this box (join App). Uses box-local fireapi, no cloud auth.
async function addPeerToApp(eid) {
  await rp({
    uri: LOCAL_ENCIPHER_API,
    method: 'POST',
    json: true,
    headers: { 'Content-Type': 'application/json' },
    body: { peers: [{ type: 'user', eid }] },
    timeout: 15000
  });
}

// fireapi (8834) may not be up yet early in onboard / after a restart; retry until it answers.
async function addPeerToAppWithRetry(eid, maxSec = 120) {
  const deadline = Date.now() + maxSec * 1000;
  let lastErr;
  while (Date.now() < deadline) {
    try { return await addPeerToApp(eid); }
    catch (e) {
      lastErr = e;
      log(`addPeers retry (${e.message})`);
      await sleep(3000);
    }
  }
  throw lastErr || new Error('addPeers timeout');
}

// ── state file (for troubleshooting) ─────────────────────────────────────────────

const STATE_FILE = '/home/pi/.firewalla/bootstrap.json';
const state = { created_at: new Date().toISOString() };

async function persistState(patch) {
  Object.assign(state, patch, { updated_at: new Date().toISOString() });
  try {
    await fs.promises.mkdir(require('path').dirname(STATE_FILE), { recursive: true });
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (e) { /* best-effort */ }
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main(onboard) {
  log('onboard start');
  const config = loadConfig();
  await connectCloud(config);
  const gid = await waitForGid();
  const mac = await networkTool.getIdentifierMAC();
  if (!mac) throw new Error('failed to read identifier MAC');
  log(`gid=${gid} mac=${mac}`);
  await persistState({ stage: 'onboard_start', gid, mac });

  const needMsp = _.get(onboard, 'activation.msp.enabled') === true;
  const needApp = _.get(onboard, 'activation.app.enabled') === true;
  const cfgLicenseUuid = _.get(onboard, 'license.uuid');

  // ── Phase 1 (unconditional on boot) ──────────────────────────────────────────
  // No MSP: license comes from onboard-config, installed on boot (usable immediately).
  // MSP selected: license comes mainly from the MSP push, deferred to Phase 2.
  if (!needMsp) {
    if (cfgLicenseUuid) {
      await installLicenseAndMark(cfgLicenseUuid, mac, 'onboard-config');
    } else {
      log('no msp & no onboard license.uuid — skipping license');
    }
  }

  // ── Phase 2: only after activate (msp / app) ──────────────────────────────────
  if (!needMsp && !needApp) {
    log('no msp/app selected — done after license');
    await persistState({ stage: 'completed', activated_at: new Date().toISOString() });
    return;
  }

  // bid is minted by the MSP backend at provision time, bound to the license, then baked into the
  // image. Fall back to a random one only if it can't be read.
  const bid = _.get(onboard, 'activation.bid') || uuid.v4();
  const rid = eptcloud.eptGenerateInvite().r;
  log(`register bid=${bid} rid=${rid}`);
  await registerBootstrap({ bootstrapId: bid, rid, gid });
  await persistState({ stage: 'awaiting_activation', bootstrap_id: bid, rid });

  // Wait until the user clicks activate in the MSP web UI.
  log('waiting for activate (polling rendezvous)...');
  const { value: webEid, evalue } = await waitForInvitation(rid);
  const payload = parsePayload(evalue);
  log(`activate confirmed: web_eid=${webEid} msp=${_.get(payload, 'business.name')}`);
  await persistState({ stage: 'activating', web_eid: webEid, payload_received_at: new Date().toISOString() });

  if (needMsp) {
    // License comes mainly from the MSP push, with onboard-config as fallback.
    const licenseUuid = payload.license || cfgLicenseUuid;
    if (!licenseUuid) throw new Error('no license from MSP payload nor onboard-config');
    await installLicenseAndMark(licenseUuid, mac, payload.license ? 'msp-payload' : 'onboard-config(fallback)');
    const memberCount = await joinWebEidToGroup(gid, webEid);
    await writeUiConf(gid);
    await configureGuardian(payload);
    log(`msp joined: members=${memberCount} server=${payload.server}${payload.region ? ` region=${payload.region}` : ''}`);
  }

  // addPeers uses the fireapi that came up on boot, so it must run before restartFireApi; non-fatal.
  if (needApp) {
    const appEid = _.get(onboard, 'activation.app.eid');
    if (appEid) {
      try {
        await addPeerToAppWithRetry(appEid);
        log(`app peer added: eid=${appEid}`);
      } catch (e) {
        log(`WARN: addPeers failed (non-fatal): ${e.message}`);
      }
    } else {
      log('app.enabled but app.eid missing — skipping addPeers');
    }
  }

  // Guardian config needs a fireapi restart to take effect; do it last (avoid interrupting addPeers).
  if (needMsp) {
    await restartFireApi();
    log('fireapi restarted');
  }

  await persistState({
    stage: 'completed',
    business: _.get(payload, 'business'),
    server: payload.server,
    region: payload.region,
    activated_at: new Date().toISOString(),
  });
  log('onboard done');
}

const onboard = loadOnboardConfig();
if (!onboard) {
  console.error(`[onboard] no/invalid onboard-config at ${ONBOARD_CONFIG} — abort`);
  process.exit(1);
}

main(onboard).catch(async (err) => {
  log(`bootstrap failed: ${err.message}`);
  if (err.stack) console.log(err.stack);
  try { await persistState({ stage: 'failed', error: err.message, failed_at: new Date().toISOString() }); } catch (_) {}
  process.exitCode = 1;
}).finally(async () => {
  try { await rclient.quitAsync(); } catch (_) { /* ignore */ }
  process.exit(process.exitCode || 0);
});
