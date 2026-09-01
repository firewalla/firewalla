'use strict';

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
const eptGroup = require('../util/eptGroup.js');
const bone = require('../lib/Bone.js');
const networkTool = require('../net2/NetworkTool.js')();
const sysManager = require('../net2/SysManager.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const nodePersist = require('node-persist');

const CONFIG_FILE = process.env.FW_CONFIG || '/encipher.config/netbot.config';
const DEFAULT_PROVISION_BASE = 'https://msp.dd.firewalla.net';
let PROVISION_BASE = DEFAULT_PROVISION_BASE;
const BOOTSTRAP_PATH = '/vmbox/bootstrap';
const ONBOARD_CONFIG = process.env.FW_ONBOARD_CONFIG || '/home/pi/.firewalla/onboard-config.json';
const ENCIPHER_DB = `${process.env.HOME || '/home/pi'}/.encipher/db`;

const POLL_INTERVAL_SEC = 5;

let eptcloud;
let cloudConfig;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = msg => console.log(`[onboard ${new Date().toISOString()}] ${msg}`);

function loadOnboardConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ONBOARD_CONFIG, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch (e) {
    return null;
  }
}

async function connectCloud() {
  cloudConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  for (const k of ['appId', 'appSecret', 'service']) {
    if (!cloudConfig[k]) throw new Error(`${CONFIG_FILE} missing field: ${k}`);
  }
  eptcloud = new Cloud(cloudConfig.endpoint_name || 'netbot', null);
  await eptcloud.loadKeys();
  await eptcloud.eptLogin(cloudConfig.appId, cloudConfig.appSecret, null, cloudConfig.endpoint_name);
}

async function ensureGid() {
  fs.mkdirSync(ENCIPHER_DB, { recursive: true });
  nodePersist.initSync({ dir: ENCIPHER_DB });

  const gid = await eptGroup.ensureGroup({
    eptcloud,
    config: cloudConfig,
    model: platform.getName(),
    storage: nodePersist
  });
  await eptGroup.publishEpt(eptcloud, gid);
  return gid;
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

async function waitForInvitation(rid) {
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
  if (!payload.license)  throw new Error('payload.license missing');
  if (!payload.server)   throw new Error('payload.server missing');
  if (!payload.business) throw new Error('payload.business missing');
  return payload;
}

async function installLicense(licenseUuid, mac) {
  await bone.waitUntilCloudReadyAsync();
  const license = await bone.getLicenseAsync(licenseUuid, mac);
  if (!license || !license.DATA || !license.DATA.UUID) {
    throw new Error(`license fetch failed for ${licenseUuid}`);
  }
  await licenseUtil.writeLicenseAsync(license);
  return license;
}

async function installLicenseAndMark(licenseUuid, mac) {
  log(`installing license ${licenseUuid}`);
  const license = await installLicense(licenseUuid, mac);
  await persistState({
    stage: 'licensed',
    license_uuid: license.DATA.UUID,
    license_type: license.DATA.LICENSE,
    bound_mac: license.DATA.MAC,
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


async function applyTimezone(tz) {
  if (!tz) {
    log('no timezone in onboard-config - skipping');
    return;
  }
  const existing = await rclient.hgetAsync('sys:config', 'timezone');
  if (existing) {
    log(`timezone already set (${existing}) - skipping`);
    return;
  }
  if (!fs.existsSync(`/usr/share/zoneinfo/${tz}`)) {
    log(`WARN: unknown timezone in onboard-config: ${tz} - skipping, is tzdata-legacy installed?`);
    return;
  }
  const err = await sysManager.setTimezone(tz);
  if (err) {
    await rclient.hdelAsync('sys:config', 'timezone');
    sysManager.timezone = null;
    log(`WARN: failed to set timezone ${tz}: ${err.message}`);
    return;
  }
  log(`timezone set to ${tz}`);
}

async function restartFireApi() {
  await execAsync('sudo systemctl restart fireapi');
}

const STATE_FILE = '/home/pi/.firewalla/bootstrap.json';
const state = { created_at: new Date().toISOString() };

async function persistState(patch) {
  Object.assign(state, patch, { updated_at: new Date().toISOString() });
  try {
    await fs.promises.mkdir(require('path').dirname(STATE_FILE), { recursive: true });
    await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (e) {}
}

async function main(onboard) {
  log('onboard start');
  await connectCloud();
  const gid = await ensureGid();
  const mac = await networkTool.getIdentifierMAC();
  if (!mac) throw new Error('failed to read identifier MAC');
  log(`gid=${gid} mac=${mac}`);
  await persistState({ stage: 'onboard_start', gid, mac });

  await applyTimezone(_.get(onboard, 'timezone'))
      .catch((e) => log(`WARN: applyTimezone failed: ${e.message}`));

  const bid = _.get(onboard, 'activation.bid') || uuid.v4();
  const rid = eptcloud.eptGenerateInvite().r;
  log(`register bid=${bid} rid=${rid}`);
  await registerBootstrap({ bootstrapId: bid, rid, gid });
  await persistState({ stage: 'awaiting_activation', bootstrap_id: bid, rid });

  log('waiting for activate (polling rendezvous)...');
  const { value: webEid, evalue } = await waitForInvitation(rid);
  const payload = parsePayload(evalue);
  log(`activate confirmed: web_eid=${webEid} msp=${_.get(payload, 'business.name')}`);
  await persistState({ stage: 'activating', web_eid: webEid, payload_received_at: new Date().toISOString() });

  await installLicenseAndMark(payload.license, mac);
  const memberCount = await joinWebEidToGroup(gid, webEid);
  await writeUiConf(gid);
  await configureGuardian(payload);
  log(`msp joined: members=${memberCount} server=${payload.server}${payload.region ? ` region=${payload.region}` : ''}`);

  await restartFireApi();
  log('fireapi restarted');

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

PROVISION_BASE = process.env.FW_PROVISION_BASE || onboard.provisionBase || DEFAULT_PROVISION_BASE;

main(onboard).catch(async (err) => {
  log(`bootstrap failed: ${err.message}`);
  if (err.stack) console.log(err.stack);
  try { await persistState({ stage: 'failed', error: err.message, failed_at: new Date().toISOString() }); } catch (_) {}
  process.exitCode = 1;
}).finally(async () => {
  try { await rclient.quitAsync(); } catch (_) {}
  process.exit(process.exitCode || 0);
});
