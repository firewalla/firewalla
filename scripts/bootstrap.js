'use strict';

// Box activation bootstrap (used by the auto-install image; currently
// exercised in Proxmox VMs but not VM-specific by design).
// Reports identifiers to the provisioning service, polls encipher rendezvous for the MSP-injected payload,
// then installs the license, joins the MSP web eid into the box group, configures Guardian, and restarts fireapi.

// TODO: too fragile when launched at firstboot. The fw-firstboot.sh gate uses
// a wall-clock timer (breaks on the no-RTC box's NTP step), proceeds even on
// timeout, and never waits for node_modules or the network. Result: this runs
// before things are ready -> require('uuid') fails, eth0 IP shows none, etc.
// Don't assume the env is ready: verify deps/redis/network up front and exit
// non-zero with a clear message instead of crashing on a require.

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
const ACTIVATE_BASE = process.env.FW_ACTIVATE_BASE || PROVISION_BASE;
const BOOTSTRAP_PATH = '/vmbox/bootstrap';

const POLL_INTERVAL_SEC = 2;
const POLL_TIMEOUT_SEC = 3600;

const DEBUG = process.argv.includes('--debug');

let eptcloud;

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m'
};

const ui = {
  banner(title) {
    const line = '═'.repeat(58);
    const pad = Math.max(0, Math.floor((58 - title.length) / 2));
    const left = ' '.repeat(pad);
    const right = ' '.repeat(58 - title.length - pad);
    console.log('');
    console.log(c.cyan + '╔' + line + '╗' + c.reset);
    console.log(c.cyan + '║' + c.reset + c.bold + left + title + right + c.reset + c.cyan + '║' + c.reset);
    console.log(c.cyan + '╚' + line + '╝' + c.reset);
    console.log('');
  },
  url(label, u) {
    console.log('');
    console.log('  ' + c.gray + label + c.reset);
    console.log('    ' + c.cyan + c.bold + u + c.reset);
    console.log('');
  },
  note(msg) { console.log('  ' + msg); },
  err(msg)  { console.log('  ' + c.red + '✗' + c.reset + ' ' + c.red + msg + c.reset); },
  step(n, title) {
    console.log('');
    console.log(c.gray + '─'.repeat(60) + c.reset);
    console.log(c.bold + c.blue + ' Step ' + n + ' · ' + c.reset + c.bold + title + c.reset);
    console.log(c.gray + '─'.repeat(60) + c.reset);
  },
  ok(msg, detail) {
    const d = detail ? c.dim + '  ' + detail + c.reset : '';
    console.log('  ' + c.green + '✓' + c.reset + ' ' + msg + d);
  },
  info(msg) { console.log('  ' + c.gray + '·' + c.reset + ' ' + c.gray + msg + c.reset); },
  warn(msg) { console.log('  ' + c.yellow + '!' + c.reset + ' ' + c.yellow + msg + c.reset); },
  kv(k, v)  { console.log('  ' + c.gray + k.padEnd(10) + c.reset + c.bold + v + c.reset); }
};

// In non-debug mode, silence the internal-diagnostic helpers.
if (!DEBUG) {
  for (const m of ['step', 'ok', 'info', 'warn', 'kv']) ui[m] = () => {};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  for (const k of ['appId', 'appSecret']) {
    if (!cfg[k]) throw new Error(`${CONFIG_FILE} missing field: ${k}`);
  }
  return cfg;
}

async function connectCloud(config) {
  eptcloud = new Cloud(config.endpoint_name || 'netbot', null);
  await eptcloud.loadKeys();
  await eptcloud.eptLogin(config.appId, config.appSecret, null, config.endpoint_name);
}

// the wait is defensive.
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

// Poll encipher rendezvous until the MSP-side lambda pushes a payload.
// Returns { value: <web_eid>, evalue: JSON({ license, server, business }) }.
async function waitForInvitation(rid) {
  const deadline = Date.now() + POLL_TIMEOUT_SEC * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await eptcloud.rendezvousMap(rid);
      if (res && res.value) return res;
    } catch (e) {
      if (e.statusCode !== 404) ui.warn(`poll error: ${e.message}`);
    }
    await sleep(POLL_INTERVAL_SEC * 1000);
  }
  throw new Error(`invitation timeout after ${POLL_TIMEOUT_SEC}s`);
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

async function configureGuardian({ server, business }) {
  const writes = {
    'ext.guardian.socketio.server':      server,
    'ext.guardian.business':             JSON.stringify(business),
    'ext.guardian.socketio.adminStatus': '1'
  };
  for (const [k, v] of Object.entries(writes)) await rclient.setAsync(k, v);
  return writes;
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
  } catch (e) { /* best-effort */ }
}

// QR rendering: try qrcode-terminal -> system qrencode -> just print URL.
// Every layer is isolated so any error stays contained.
function renderQr(url) {
  try {
    const qrcode = require('qrcode-terminal');
    qrcode.generate(url, { small: true });
    return true;
  } catch (e1) {
    try {
      const { execSync } = require('child_process');
      const out = execSync('qrencode -t UTF8 -- ' + JSON.stringify(url), { encoding: 'utf8' });
      process.stdout.write(out);
      return true;
    } catch (e2) {
      console.log('  (no QR renderer available — qrcode-terminal or qrencode missing)');
      console.log('  URL: ' + url);
      return false;
    }
  }
}

// readline-based "qr" listener: while bootstrap is polling for activation
// the user can type "qr" + Enter to render a QR code of the activate URL.
// Defensive: any error inside the line handler is swallowed so it can't
// kill the bootstrap process via uncaughtException.
let qrRl = null;
let qrCount = 0;
function startQrListener(url) {
  // process.stdin may be paused by default with terminal:false on Node 12.
  try { process.stdin.setEncoding('utf8'); } catch (_) {}
  try { process.stdin.resume(); } catch (_) {}
  const readline = require('readline');
  qrRl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  qrRl.on('line', (raw) => {
    try {
      if (raw.trim().toLowerCase() !== 'qr') return;
      qrCount++;
      console.log('');
      console.log('  Rendering QR for: ' + url);
      console.log('');
      if (qrCount === 1) {
        renderQr(url);
      } else {
        console.log('  (QR already rendered above — scroll up in noVNC to see it.)');
        console.log('  URL: ' + url);
      }
      console.log('');
    } catch (e) {
      try { console.log('  (qr command failed: ' + e.message + ')'); } catch (_) {}
    }
  });
}
function stopQrListener() {
  if (qrRl) { try { qrRl.close(); } catch (_) {} qrRl = null; }
}

async function main() {
  ui.banner('  Firewalla Software Activation  ');

  const config = loadConfig();

  ui.step(1, 'Connect to Firewalla cloud');
  await connectCloud(config);
  ui.ok('Logged in');

  ui.step(2, 'Prepare activation request');
  const gid = await waitForGid();
  const mac = await networkTool.getIdentifierMAC();
  if (!mac) throw new Error('failed to read identifier MAC');
  const rid = eptcloud.eptGenerateInvite().r;
  const bootstrapId = uuid.v4();
  ui.kv('GID', gid);
  ui.kv('MAC', mac);
  ui.kv('RID', rid);
  ui.kv('Bootstrap', bootstrapId);

  ui.step(3, 'Register with provisioning service');
  await registerBootstrap({ bootstrapId, rid, gid });
  ui.ok('Registered');
  const activateUrl = `${ACTIVATE_BASE}/?bid=${bootstrapId}`;
  ui.url('Open this URL to activate:', activateUrl);
  console.log('  ' + c.dim + 'Type ' + c.reset + c.bold + '"qr" + Enter' + c.reset + c.dim +
              ' on this console to render a QR code of the URL above.' + c.reset);
  console.log('');

  await persistState({
    stage: 'awaiting_activation',
    bootstrap_id: bootstrapId,
    rid, gid, mac,
    activate_url: activateUrl,
  });
  startQrListener(activateUrl);

  ui.step(4, 'Wait for MSP payload');
  ui.info(`Polling rendezvous every ${POLL_INTERVAL_SEC}s (timeout ${POLL_TIMEOUT_SEC}s)`);
  ui.note('Waiting for activation to be confirmed in the browser...');
  const { value: webEid, evalue } = await waitForInvitation(rid);
  stopQrListener();
  const payload = parsePayload(evalue);
  await persistState({
    stage: 'activating',
    web_eid: webEid,
    payload_received_at: new Date().toISOString(),
  });
  ui.ok('Invitation received');
  ui.kv('Web eid', webEid);
  ui.kv('License', payload.license);
  ui.kv('MSP', `${payload.business.name} (${payload.business.id})`);
  ui.kv('Server', payload.server);

  ui.step(5, 'Apply activation');
  ui.note('Applying configuration...');

  const license = await installLicense(payload.license, mac);
  ui.ok('License installed');
  ui.kv('UUID',  license.DATA.UUID);
  ui.kv('Type',  license.DATA.LICENSE);
  ui.kv('SUUID', license.DATA.SUUID);
  ui.kv('Bound MAC', license.DATA.MAC);

  const memberCount = await joinWebEidToGroup(gid, webEid);
  ui.ok('Web eid joined group');
  ui.kv('Members', String(memberCount));

  await writeUiConf(gid);
  ui.ok('ui.conf written');

  const writes = await configureGuardian(payload);
  ui.ok('Guardian configured');
  for (const [k, v] of Object.entries(writes)) {
    ui.kv(k, v.length > 60 ? v.slice(0, 60) + '...' : v);
  }

  await restartFireApi();
  ui.ok('FireAPI restarting');

  await persistState({
    stage: 'completed',
    license_uuid: license.DATA.UUID,
    license_type: license.DATA.LICENSE,
    bound_mac: license.DATA.MAC,
    business: payload.business,
    server: payload.server,
    activated_at: new Date().toISOString(),
  });

  ui.banner('  Activation Complete  ');
  ui.note(`Connected to MSP: ${payload.server}`);
  ui.note(`State saved to ${STATE_FILE}`);
  console.log('');
}

main().catch(async (err) => {
  console.log('');
  ui.err(`bootstrap failed: ${err.message}`);
  if (err.stack) console.log(c.dim + err.stack + c.reset);
  console.log('');
  try { await persistState({ stage: 'failed', error: err.message, failed_at: new Date().toISOString() }); } catch (_) {}
  process.exitCode = 1;
}).finally(async () => {
  try { stopQrListener(); } catch (_) { /* ignore */ }
  try { await rclient.quitAsync(); } catch (_) { /* ignore */ }
  process.exit(process.exitCode || 0);
});
