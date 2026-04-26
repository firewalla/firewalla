/*    Copyright 2016-2025 Firewalla Inc.
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
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const fs = require('fs');
const http = require('http');
const path = require('path');

const f = require('../net2/Firewalla.js');
const fireRouter = require('../net2/FireRouter.js');
const networkProfileManager = require('../net2/NetworkProfileManager.js');
const sysManager = require('../net2/SysManager.js');

const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const flowTool = require('../net2/FlowTool.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const redis = require('redis');
const APCMsgSensor = require('../sensor/APCMsgSensor.js');
const ACLAuditLogPlugin = require('../sensor/ACLAuditLogPlugin.js');
const { getUniqueTs } = require('../net2/FlowUtil.js');

/** Redis DB 3 client for `dap:internal:*` (same as `rc -n 3`). */
let dapTestRclientDb3 = null;
function getDapTestRedisClientDb3() {
  if (!dapTestRclientDb3) {
    dapTestRclientDb3 = redis.createClient({ db: 3 });
    dapTestRclientDb3.on('error', () => {});
  }
  return dapTestRclientDb3;
}

/** Single test device (IPv4 + MAC keys); isolated from sample_data.js */
const DAP_TEST_HOST_IP = '172.17.0.10';
const DAP_TEST_HOST_MAC = 'AA:BB:CC:DD:EE:FF';
const DAP_TEST_DEST_IP = '114.113.217.103';
const DAP_TEST_DEST_IP2 = '114.113.217.104';
/** Remote L2 address for default conn-flow fixtures (see local flow builders). */
const DAP_TEST_DEST_MAC = '00:22:44:66:88:11';
/** Dest IPv4/MAC/domain used only for APC block-flow payloads (distinct from conn-flow dests). */
const DAP_TEST_BLOCK_DEST_IP = '203.0.113.50';
const DAP_TEST_BLOCK_DEST_IP2 = '203.0.113.51';
const DAP_TEST_BLOCK_DEST_MAC = 'AA:11:22:33:44:55';
const DAP_TEST_BLOCK_DOMAIN_HOST = 'github.com';
/** LAN peers for local-flow fixtures (stored under `flow:local:<mac>`). */
const DAP_TEST_LOCAL_PEER_IP = '172.17.0.20';
const DAP_TEST_LOCAL_PEER_IP2 = '172.17.0.21';
const DAP_TEST_LOCAL_PEER_MAC2 = '11:22:33:44:55:66';

/** Base unix timestamp for default flow records (matches sample_data pattern) */
const dapFlowTimestamp = Math.floor(new Date() / 1000);

// set env DAP_BIN
// process.env.DAP_BIN = "/data/dapenv/dap";

/**
 * Build the same four flow objects sample_data uses for the first host (in/out × two dests).
 * Callers may clone and tweak for additional scenarios.
 */
function buildDapDefaultFlowObjects(ts, hostIP, destIP, destIP2) {
  const flow1 = {
    ts : ts - 1,
    _ts: ts - 1,
    __ts: ts -1,
    sh: hostIP,
    dh: destIP,
    ob: 100,
    rb: 200,
    ct: 1,
    fd: 'in',
    lh: hostIP,
    du: 100,
    pf: { 'udp.8000': { ob: 262, rb: 270, ct: 1 } },
    af: {},
    pr: 'tcp',
    f: null,
    flows: [[1500975078, 1500975078, 262, 270]]
  };
  const flow2 = {
    ts: ts,
    _ts: ts,
    __ts: ts,
    sh: hostIP,
    dh: destIP,
    ob: 100,
    rb: 200,
    ct: 1,
    fd: 'in',
    lh: hostIP,
    du: 300,
    pf: { 'udp.8000': { ob: 262, rb: 270, ct: 1 } },
    af: {},
    pr: 'tcp',
    f: null,
    flows: [[1500975078, 1500975078, 262, 270]]
  };
  const flow3 = JSON.parse(JSON.stringify(flow1));
  flow3.dh = destIP2;
  flow3.ob = 300;
  flow3.rb = 400;
  flow3.fd = 'out';
  const flow4 = JSON.parse(JSON.stringify(flow2));
  flow4.dh = destIP2;
  flow4.ob = 300;
  flow4.rb = 400;
  flow4.fd = 'out';
  return { flow1, flow2, flow3, flow4 };
}

/**
 * Build four local (LAN↔LAN) flow objects, same pair index scheme as
 * buildDapDefaultFlowObjects. Matches BroDetect tmpspec shape for `flow:local:*`.
 */
function buildDapLocalFlowObjects(ts, hostIP, peerIP, peerIP2) {
  const intf = '00000001';
  const dIntf = '00000001';
  const flow1 = {
    ts: ts - 1,
    _ts: ts - 1,
    __ts: ts - 1,
    sh: hostIP,
    dh: peerIP,
    ob: 100,
    rb: 200,
    ct: 1,
    fd: 'in',
    lh: hostIP,
    du: 100,
    intf,
    dIntf,
    dmac: DAP_TEST_DEST_MAC,
    ltype: 'mac',
    pf: { 'udp.8000': { ob: 262, rb: 270, ct: 1 } },
    af: {},
    pr: 'tcp',
    f: null,
    flows: [[1500975078, 1500975078, 262, 270]]
  };
  const flow2 = {
    ts: ts,
    _ts: ts,
    __ts: ts,
    sh: hostIP,
    dh: peerIP,
    ob: 100,
    rb: 200,
    ct: 1,
    fd: 'in',
    lh: hostIP,
    du: 300,
    intf,
    dIntf,
    dmac: DAP_TEST_DEST_MAC,
    ltype: 'mac',
    pf: { 'udp.8000': { ob: 262, rb: 270, ct: 1 } },
    af: {},
    pr: 'tcp',
    f: null,
    flows: [[1500975078, 1500975078, 262, 270]]
  };
  const flow3 = JSON.parse(JSON.stringify(flow1));
  flow3.dh = peerIP2;
  flow3.dmac = DAP_TEST_LOCAL_PEER_MAC2;
  flow3.ob = 300;
  flow3.rb = 400;
  flow3.fd = 'out';
  const flow4 = JSON.parse(JSON.stringify(flow2));
  flow4.dh = peerIP2;
  flow4.dmac = DAP_TEST_LOCAL_PEER_MAC2;
  flow4.ob = 300;
  flow4.rb = 400;
  flow4.fd = 'out';
  return { flow1, flow2, flow3, flow4 };
}

async function createDapTestHost() {
  const tsStr = new Date() / 1000 + '';
  //host:ip4:172.17.0.10
  await hostTool.updateIPv4Host({
    ipv4Addr: DAP_TEST_HOST_IP,
    mac: DAP_TEST_HOST_MAC,
    uid: DAP_TEST_HOST_IP,
    lastActiveTimestamp: tsStr,
    firstFoundTimestamp: tsStr,
    hostname: 'DAP Test Device',
    hostnameType: 'PTR',
    macVendor: 'Apple'
  });
  // host:mac:AA:BB:CC:DD:EE:FF 
  await hostTool.updateMACKey({
    bname: 'DAP Test Device',
    host: 'DAP Test Device',
    uid: DAP_TEST_HOST_IP,
    lastActiveTimestamp: tsStr,
    firstFoundTimestamp: tsStr,
    pname: 'UnknownMobile/iOS',
    mac: DAP_TEST_HOST_MAC,
    _name: 'iPhone',
    ipv4Addr: DAP_TEST_HOST_IP,
    macVendor: 'Apple',
    deviceClass: 'mobile',
    ua_os_name: 'iOS',
    ipv4: DAP_TEST_HOST_IP,
    ipv6Addr: '["fe80::aa07:d334:59a3:1200", "fe80::aa07:d334:59a3:1201"]'
  });
}

async function removeDapTestHost() {
  await Promise.all([
    hostTool.deleteHost(DAP_TEST_HOST_IP),
    hostTool.deleteMac(DAP_TEST_HOST_MAC)
  ]);
}

/**
 * Add one pair of default flows: one `in` and one `out` (same pairing as
 * buildDapDefaultFlowObjects: pair 0 → flow1+flow3, pair 1 → flow2+flow4).
 * @param {0|1} pairIndex
 */
async function createDapDefaultFlowPair(pairIndex) {
  const { flow1, flow2, flow3, flow4 } = buildDapDefaultFlowObjects(
    dapFlowTimestamp,
    DAP_TEST_HOST_IP,
    DAP_TEST_DEST_IP,
    DAP_TEST_DEST_IP2
  );
  if (pairIndex === 0) {
    await flowTool.addFlow(DAP_TEST_HOST_MAC, 'in', flow1);
    await flowTool.addFlow(DAP_TEST_HOST_MAC, 'out', flow3);
  } else {
    await flowTool.addFlow(DAP_TEST_HOST_MAC, 'in', flow2);
    await flowTool.addFlow(DAP_TEST_HOST_MAC, 'out', flow4);
  }
}

/**
 * Append one pair of local flows to `flow:local:<mac>` (same pairing as
 * buildDapLocalFlowObjects: pair 0 → flow1+flow3, pair 1 → flow2+flow4).
 * Uses `_ts` as the Redis zset score, consistent with BroDetect.
 * @param {0|1} pairIndex
 */
async function createDapLocalFlowPair(pairIndex) {
  const { flow1, flow2, flow3, flow4 } = buildDapLocalFlowObjects(
    dapFlowTimestamp,
    DAP_TEST_HOST_IP,
    DAP_TEST_LOCAL_PEER_IP,
    DAP_TEST_LOCAL_PEER_IP2
  );
  const key = `flow:local:${DAP_TEST_HOST_MAC}`;
  if (pairIndex === 0) {
    await rclient.zaddAsync(key, flow1._ts, JSON.stringify(flow1));
    await rclient.zaddAsync(key, flow3._ts, JSON.stringify(flow3));
  } else {
    await rclient.zaddAsync(key, flow2._ts, JSON.stringify(flow2));
    await rclient.zaddAsync(key, flow4._ts, JSON.stringify(flow4));
  }
}

/** All four default flows (two pairs). */
async function createDapDefaultFlows() {
  await createDapDefaultFlowPair(0);
  await createDapDefaultFlowPair(1);
}

async function removeDapDefaultFlows() {
  if (!DAP_TEST_HOST_MAC) {
    return;
  }
  const  flowMac  = DAP_TEST_HOST_MAC;
  await rclient.delAsync(
    `flow:conn:in:${flowMac}`,
    `flow:conn:out:${flowMac}`,
    `flow:local:${flowMac}`
  );
}


async function removeDapAuditDropFlows() {
  if (!DAP_TEST_HOST_MAC) {
    return;
  }
  const  flowMac  = DAP_TEST_HOST_MAC;
  await rclient.delAsync(
    `audit:drop:${flowMac}`
  );
}
/**
 * Build one FWAPC block-flow payload for the DAP test host (same fields as
 * test_apcmsg_sensor.js → processApcBlockFlowMessage). Merge `overrides` last;
 * set `pid` there (or pass it via createDapApcBlockedFlows).
 * @param {object} overrides
 * @returns {object}
 */
function buildDapApcBlockFlowMessage(overrides) {
  const base = {
    action: 'block',
    src: DAP_TEST_HOST_IP,
    dst: DAP_TEST_BLOCK_DEST_IP,
    sport: 12345,
    dport: 54321,
    smac: DAP_TEST_HOST_MAC,
    dmac: DAP_TEST_BLOCK_DEST_MAC,
    ct: 1,
    ts: Date.now() / 1000,
    proto: 'udp'
  };
  return Object.assign({}, base, overrides);
}

/**
 * Feed a single block-flow through APCMsgSensor.processApcBlockFlowMessage (Redis/APC audit path).
 * @param {import('../sensor/APCMsgSensor.js')} apcSensor
 * @param {object} msg
 */
function submitDapApcBlockedFlow(apcSensor, msg) {
  apcSensor.processApcBlockFlowMessage(JSON.stringify(msg));
}

/**
 * Create several blocked-flow audit records for the DAP test device, all tagged with `pid`
 * (policy id / isolation id per APCMsgSensor).
 * @param {import('../sensor/APCMsgSensor.js')} apcSensor
 * @param {number} pid
 * @param {object[]=} flowSpecs - per-flow overrides merged onto defaults; default is three varied flows
 */
function createDapApcBlockedFlows(apcSensor, pid, flowSpecs) {
  const specs = flowSpecs || [
    {},
    { dst: DAP_TEST_BLOCK_DEST_IP2, sport: 50001, dport: 443, proto: 'tcp' },
    { sport: 40000, dport: 80, proto: 'tcp', dst: DAP_TEST_BLOCK_DEST_IP }
  ];
  for (const spec of specs) {
    const msg = buildDapApcBlockFlowMessage(Object.assign({ pid }, spec, { ts: Date.now() / 1000 }));
    submitDapApcBlockedFlow(apcSensor, msg);
  }
}

/**
 * iptables-style WAN ACL block record: `dir` is `O` (not `L`), so
 * {@link ACLAuditLogPlugin#writeLogs} writes to `audit:drop:<mac>` (and `audit:drop:system`),
 * not `audit:local:drop:*` (APC path uses `dir: 'L'`).
 * Semantics: outbound from LAN — `fd` is `in`, `sh`/`dh` are src/dst IPs; `sp` is a port array per plugin.
 * @param {object=} overrides
 * @returns {object}
 */
function buildDapAuditDropBlockRecord(overrides) {
  const ts = Date.now() / 1000;
  const base = {
    type: 'ip',
    ac: 'block',
    ts,
    _ts: getUniqueTs(ts),
    ct: 1,
    sh: DAP_TEST_HOST_IP,
    dh: DAP_TEST_BLOCK_DEST_IP,
    sp: [50001],
    dp: 443,
    pr: 'tcp',
    mac: DAP_TEST_HOST_MAC,
    fd: 'in',
    dir: 'O'
  };
  return Object.assign({}, base, overrides);
}

/**
 * Buffer iptables-like block flows for {@link ACLAuditLogPlugin#writeLogs} → `audit:drop:<mac>`.
 * @param {import('../sensor/ACLAuditLogPlugin.js')} plugin
 * @param {number|undefined} pid
 * @param {object[]=} flowSpecs - merged into each record; use `dh`/`sp`/`dp`/`pr` (not APC `dst`/`sport`)
 */
function createDapAuditDropBlockedFlows(plugin, pid, flowSpecs) {
  const specs = flowSpecs || [
    {},
    { dh: DAP_TEST_BLOCK_DEST_IP2, sp: [50002], dp: 443, pr: 'tcp' },
    { sp: [40000], dp: 80, pr: 'tcp', dh: DAP_TEST_BLOCK_DEST_IP }
  ];
  ensureAclAuditLogPluginRuleStatsForTest(plugin);
  for (const spec of specs) {
    const merged = Object.assign({ pid, ts: ((Date.now() / 1000) - 2) }, spec);
    const record = buildDapAuditDropBlockRecord(merged);
    record._ts = getUniqueTs(record.ts);
    plugin.writeBuffer(record);
  }
}

/**
 * Persist buffered audit records (e.g. after {@link #createDapAuditDropBlockedFlows}).
 * @param {import('../sensor/ACLAuditLogPlugin.js')} plugin
 */
async function flushDapAuditDropBuffer(plugin) {
  ensureAclAuditLogPluginRuleStatsForTest(plugin);
  await plugin.writeLogs();
}

/**
 * `ACLAuditLogPlugin.run()` (which sets `ruleStatsPlugin` from SensorLoader) is not invoked when
 * the plugin is created via `initSingleSensor` only. Stub so `writeLogs` can run in tests.
 * @param {import('../sensor/ACLAuditLogPlugin.js')} plugin
 */
function ensureAclAuditLogPluginRuleStatsForTest(plugin) {
  if (plugin.ruleStatsPlugin) {
    return;
  }
  plugin.ruleStatsPlugin = {
    accountRule() {},
    getMatchedPids: async () => [],
    getPolicyIds: async () => []
  };
}

/**
 * `processApcBlockFlowMessage` only fills ACLAuditLogPlugin buffers; persist to Redis for DAP.
 * @param {import('../sensor/APCMsgSensor.js')} apcSensor
 */
async function flushDapApcAuditBuffer(apcSensor) {
  const deadline = Date.now() + 5000;
  while (!apcSensor.aclAuditLogPlugin && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const plugin = apcSensor.aclAuditLogPlugin;
  if (plugin) {
    ensureAclAuditLogPluginRuleStatsForTest(plugin);
    await plugin.writeLogs();
  }
}

async function addDapTestIntelInfo() {
  const entries = [
    [DAP_TEST_DEST_IP, 'www.google.com'],
    [DAP_TEST_DEST_IP2, 'www.google.com'],
    [DAP_TEST_BLOCK_DEST_IP, DAP_TEST_BLOCK_DOMAIN_HOST],
    [DAP_TEST_BLOCK_DEST_IP2, DAP_TEST_BLOCK_DOMAIN_HOST]
  ];
  await Promise.all(
    entries.map(async ([ip, host]) => {
      const key = 'intel:ip:' + ip;
      await rclient.hmsetAsync(key, {
        ip: ip,
        host: host,
        country: 'US',
        app: 'search',
        apps: '{"search": "100"}'
      });
    })
  );
}

async function removeDapTestIntelInfo() {
  const ips = [
    DAP_TEST_DEST_IP,
    DAP_TEST_DEST_IP2,
    DAP_TEST_BLOCK_DEST_IP,
    DAP_TEST_BLOCK_DEST_IP2
  ];
  await Promise.all(
    ips.map(async (ip) => {
      await rclient.delAsync('intel:ip:' + ip);
    })
  );
}

/**
 * Remove Redis keys written during DAP analyze / policy-json for a device.
 * Default MAC is {@link DAP_TEST_HOST_MAC}; add more deletes here as needed.
 * @param {string=} mac
 */
async function removeDapAnalysisTestData(mac) {
  const m = mac != null ? mac : DAP_TEST_HOST_MAC;
  const rc3 = getDapTestRedisClientDb3();
  await Promise.all([
    rclient.delAsync('policy:mac:' + m),
    rc3.delAsync('dap:internal:' + m),
    rc3.delAsync('local_neighbor:history:' + m)
  ]);
}

// await setHostPolicyField('AA:BB:CC:DD:EE:FF', 'dapAdmin', { state: false });
async function setHostPolicyField(mac, field, value) {
  const key = 'policy:mac:' + mac;
  if (value === undefined) {
    await rclient.hdelAsync(key, field);
  } else {
    await rclient.hmsetAsync(key, field, JSON.stringify(value));
  }
}

/**
 * Path to the `dap` executable. Override with env DAP_BIN (see scripts/alias.sh on device).
 */
function getDapBinary() {
  if (process.env.DAP_BIN) {
    return process.env.DAP_BIN;
  }
  return path.join(f.getRuntimeInfoFolder(), 'assets', 'dap');
}

function isDapBinaryExecutable() {
  try {
    fs.accessSync(getDapBinary(), fs.constants.X_OK);
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Run the dap CLI. `args` is an argv array without the binary (e.g. ['analyze', '-m', mac]).
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runDap(args, execOpts) {
  const bin = getDapBinary();
  const opts = Object.assign({ maxBuffer: 10 * 1024 * 1024 }, execOpts);
  return execFileAsync(bin, args, opts);
}

/**
 * POST /v1/devices/:mac/state — local DAP HTTP API (e.g. curl to 127.0.0.1:8843).
 * @param {string} mac Device MAC (e.g. AA:BB:CC:DD:EE:FF)
 * @param {string} state Policy state value (e.g. 'not_applicable')
 * @param {{ host?: string, port?: number }} [opts]
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postDapDeviceState(mac, state, opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port != null ? opts.port : 8843;
  const body = JSON.stringify({ state });
  const pathName = `/v1/devices/${encodeURIComponent(mac)}/state`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path: pathName,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: data });
          } else {
            const err = new Error(`postDapDeviceState: HTTP ${res.statusCode} ${data}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Netbot encipher simple endpoint for DAP proxy commands (see curl to :8834). */
const DAP_ENCIPHER_SIMPLE_QUERY = '/v1/encipher/simple?command=cmd&item=dap';

/**
 * POST a DAP REST path through {@link DAP_ENCIPHER_SIMPLE_QUERY} (same as
 * `curl .../v1/encipher/simple?command=cmd&item=dap` with JSON `{ method, path }`).
 * @param {string} dapRestPath e.g. `/reset-stats-all` or `/reset-stats/AA:BB:CC:DD:EE:FF`
 * @param {{ host?: string, port?: number }} [opts]
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postDapEncipherSimple(dapRestPath, opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port != null ? opts.port : 8834;
  const body = JSON.stringify({ method: 'POST', path: dapRestPath });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path: DAP_ENCIPHER_SIMPLE_QUERY,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, body: data });
          } else {
            const err = new Error(`postDapEncipherSimple: HTTP ${res.statusCode} ${data}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Reset DAP stats for all devices (`path`: `/reset-stats-all`).
 * @param {{ host?: string, port?: number }} [opts]
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postDapResetStatsAllEncipher(opts) {
  return postDapEncipherSimple('/reset-stats-all', opts);
}

/**
 * Reset DAP stats for one device (`path`: `/reset-stats/<mac>`).
 * @param {string} mac Device MAC (e.g. AA:BB:CC:DD:EE:FF)
 * @param {{ host?: string, port?: number }} [opts]
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postDapResetStatsForMacEncipher(mac, opts) {
  return postDapEncipherSimple('/reset-stats/' + mac, opts || {});
}

function parseDapPolicyFromStdout(stdout) {
  const policyTag = '📋 DAP Policy:';
  const internalTag = '📊 DAP Internal:';
  const start = stdout.indexOf(policyTag);
  const end = stdout.indexOf(internalTag, start);
  if (start === -1 || end === -1) {
    throw new Error('DAP output missing DAP Policy / DAP Internal markers');
  }
  const policyJsonStr = stdout.substring(start + policyTag.length, end).trim();
  const cleanedJson = policyJsonStr
    .replace(/,\s*…":\s*false/g, '')
    .replace(/,\s*([\]}])/g, '$1')
    .trim();
  return JSON.parse(cleanedJson);
}

describe('DAP CLI — device analyze & flows', function () {
  this.timeout(120000);

  before(async () => {
    await fireRouter.waitTillReady();
    await sysManager.updateAsync();
    await networkProfileManager.updatePrefixMap();
  });


  describe('with DAP test host in learning & default flows', () => {
    beforeEach(async () => {
      await createDapTestHost();
      await addDapTestIntelInfo();
    });

    afterEach(async () => {
      await removeDapAnalysisTestData();
      await removeDapDefaultFlows();
      await removeDapAuditDropFlows();
      await removeDapTestIntelInfo();
      await removeDapTestHost();
    });

    describe('fixtures', () => {
      it.skip('should expose MAC and flow timestamps used by dap -m / -t', () => {
        expect(DAP_TEST_HOST_MAC).to.match(/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/);
        expect(dapFlowTimestamp).to.be.a('number');
      });
    });


    describe('check learnedCount value in learning state of the device', () => {

      it.skip('should record learnedCount in dap policy correctly', async () => {

        await createDapDefaultFlowPair(0);
        // pick a device to analyze
        let { stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]);
        const policy = parseDapPolicyFromStdout(stdout);
        expect(policy.learnedCount).to.equal(2);
        expect(policy.state).to.equal('learning');

        // repeat analyze to check if learning status is consistent
        // await new Promise(resolve => setTimeout(resolve, 1000));
        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy2 = parseDapPolicyFromStdout(stdout);
        expect(policy2.learnedCount).to.equal(2);
        expect(policy2.state).to.equal('learning');


        // add another flow pair to check if learning status is updated
        await createDapDefaultFlowPair(1);
        // await new Promise(resolve => setTimeout(resolve, 1000));
        // ({ stdout } = await runDap(['query-flows', '-m', DAP_TEST_HOST_MAC]));
        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy3 = parseDapPolicyFromStdout(stdout);
        expect(policy3.learnedCount).to.equal(4);
        expect(policy3.state).to.equal('learning');
        expect(policy3.lastUpdated).to.be.a('number');
        expect(policy3.lastCloudCheck).to.be.a('number');
      });
    });

    describe('check localLearnedCount value in learning state of the device', () => {
      it.skip('should record localLearnedCount in dap policy correctly', async () => {

        await runDap(['transfer-to-learning', '-m', DAP_TEST_HOST_MAC]);
        await createDapLocalFlowPair(0);
        // pick a device to analyze
        let { stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]);
        let policy = parseDapPolicyFromStdout(stdout);
        expect(policy.localLearnedCount).to.equal(2);
        expect(policy.localAclState).to.equal('learning');
        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        policy = parseDapPolicyFromStdout(stdout);
        expect(policy.localLearnedCount).to.equal(2);
        expect(policy.localAclState).to.equal('not_applicable');
      });
    });

    describe('check learnedCount value in optimizing state of the device', () => {
      let aclAuditLogPlugin;

      before(() => {
        sysManager.iptablesReady = true;
        aclAuditLogPlugin = new ACLAuditLogPlugin({});
        ensureAclAuditLogPluginRuleStatsForTest(aclAuditLogPlugin);
      });

      it.skip('should record learnedCount in dap policy correctly ', async () => {

        await createDapDefaultFlowPair(0);
        // pick a device to analyze
        let { stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]);
        const policy = parseDapPolicyFromStdout(stdout);
        expect(policy.learnedCount).to.equal(2);
        expect(policy.state).to.equal('learning');

        ({ stdout } = await runDap(['transfer-to-optimizing', '-m', DAP_TEST_HOST_MAC]));
        const policy2 = parseDapPolicyFromStdout(stdout);
        expect(policy2.learnedCount).to.equal(2);

        const blockRuleId = policy2.finalRuleSet.blockRuleId || '';
        expect(blockRuleId).to.not.be.empty;
        const blockPid = Number(blockRuleId);
        expect(blockPid).to.be.finite;

        const flowSpecs = [
          { dst: DAP_TEST_BLOCK_DEST_IP, sport: 50001, dport: 443, proto: 'tcp' }
        ];
        createDapAuditDropBlockedFlows(aclAuditLogPlugin, blockPid, flowSpecs);
        await flushDapAuditDropBuffer(aclAuditLogPlugin);
        await new Promise(resolve => setTimeout(resolve, 1000));
        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy3 = parseDapPolicyFromStdout(stdout);
        expect(policy3.learnedCount).to.equal(policy2.learnedCount + 1);
        expect(policy3.state).to.equal('optimizing');

        //same domain will only be counted once
        const flowSpecs2 = [
          { dst: DAP_TEST_BLOCK_DEST_IP2, sport: 50002, dport: 443, proto: 'tcp' }
        ];
        createDapAuditDropBlockedFlows(aclAuditLogPlugin, blockPid, flowSpecs2);
        await flushDapAuditDropBuffer(aclAuditLogPlugin);
        await new Promise(resolve => setTimeout(resolve, 1000));
        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy4 = parseDapPolicyFromStdout(stdout);
        expect(policy4.learnedCount).to.equal(policy2.learnedCount + 1);

        await postDapDeviceState(DAP_TEST_HOST_MAC, 'not_applicable');
        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy5 = parseDapPolicyFromStdout(stdout);
        expect(policy5.state).to.equal('not_applicable');
        expect(policy5.learnedCount).to.equal(policy2.learnedCount + 1);

        // when device transfer to learning state, learnedCount should be reset to 0
        // but localLearnedCount should not be reset
        ({ stdout } = await runDap(['transfer-to-learning', '-m', DAP_TEST_HOST_MAC]));
        const policy6 = parseDapPolicyFromStdout(stdout);
        expect(policy6.learnedCount).to.equal(0);

      });
    });

    describe('check localLearnedCount value in optimizing state of the device', () => {
      let apcSensor;

      before(() => {
        sysManager.iptablesReady = true;
        apcSensor = new APCMsgSensor({});
      });

      it.skip('should record localLearnedCount in dap policy correctly ', async () => {

        // await createDapDefaultFlowPair(0);
        // pick a device to analyze
        let { stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]);
        const policy = parseDapPolicyFromStdout(stdout);
        // expect(policy.learnedCount).to.equal(2);
        expect(policy.state).to.equal('learning');

        ({ stdout } = await runDap(['transfer-to-optimizing', '-m', DAP_TEST_HOST_MAC]));
        const policy2 = parseDapPolicyFromStdout(stdout);
        expect(policy2.state).to.equal('optimizing');

        const blockRuleId = policy2.finalRuleSet.blockRuleId || '';
        expect(blockRuleId).to.not.be.empty;
        const blockPid = Number(blockRuleId);
        expect(blockPid).to.be.finite;

        // dap set-local-ci -m <MAC> -v <数值>
        ({ stdout } = await runDap(['set-local-ci', '-m', DAP_TEST_HOST_MAC, '-v', '1441']));

        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy3 = parseDapPolicyFromStdout(stdout);
        expect(policy3.localAclState).to.equal('optimizing');

        // investigate how to set device as isolation
        // const flowSpecs = [
        //   { dst: DAP_TEST_BLOCK_DEST_IP, sport: 50001, dport: 443, proto: 'tcp' }
        // ];
        // createDapApcBlockedFlows(apcSensor, blockPid, flowSpecs);
        // await flushDapApcAuditBuffer(apcSensor);
        // await new Promise(resolve => setTimeout(resolve, 1000));
        // ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        // const policy4 = parseDapPolicyFromStdout(stdout);
        // expect(policy4.localLearnedCount).to.equal(1);
        // expect(policy4.localAclState).to.equal('optimizing');
      });
    });

    describe('reset learnedCount value in learning state of a device', () => {

      it('should reset learnedCount in dap policy correctly', async () => {

        await createDapDefaultFlowPair(0);
        // pick a device to analyze
        let { stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]);
        const policy = parseDapPolicyFromStdout(stdout);
        expect(policy.learnedCount).to.equal(2);
        expect(policy.state).to.equal('learning');

        // add another flow pair to check if learning status is updated
        await createDapDefaultFlowPair(1);
        // await new Promise(resolve => setTimeout(resolve, 1000));
        // ({ stdout } = await runDap(['query-flows', '-m', DAP_TEST_HOST_MAC]));
        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy2 = parseDapPolicyFromStdout(stdout);
        expect(policy2.learnedCount).to.equal(4);
        expect(policy2.state).to.equal('learning');
        expect(policy2.lastUpdated).to.be.a('number');
        expect(policy2.lastCloudCheck).to.be.a('number');

        const { statusCode, body } = await postDapResetStatsForMacEncipher(DAP_TEST_HOST_MAC);
        expect(statusCode).to.equal(200);

        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy3 = parseDapPolicyFromStdout(stdout);
        expect(policy3.learnedCount).to.equal(0);
        expect(policy3.state).to.equal('learning');
        expect(policy3.lastUpdated).to.be.a('number');
        expect(policy3.lastCloudCheck).to.be.a('number');
      });

      it('should return 404 for non-existent device', async () => {
        const { statusCode, message } = await postDapResetStatsForMacEncipher("AA:BB:CC:DD:EE:00").catch(err => {
          return { statusCode: err.statusCode, message: err.message };
        });
        expect(statusCode).to.equal(500);
        expect(message).to.match(/Error: DAP API call failed: 404/);
      });
    });


    describe('reset learnedCount value for all devices', () => {
      it('should reset learnedCount for all devices correctly', async () => {
        await createDapDefaultFlowPair(0);
        // pick a device to analyze
        let { stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]);
        const policy = parseDapPolicyFromStdout(stdout);
        expect(policy.learnedCount).to.equal(2);
        expect(policy.state).to.equal('learning');

        // add another flow pair to check if learning status is updated
        await createDapDefaultFlowPair(1);
        // await new Promise(resolve => setTimeout(resolve, 1000));
        // ({ stdout } = await runDap(['query-flows', '-m', DAP_TEST_HOST_MAC]));
        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy2 = parseDapPolicyFromStdout(stdout);
        expect(policy2.learnedCount).to.equal(4);
        expect(policy2.state).to.equal('learning');
        expect(policy2.lastUpdated).to.be.a('number');
        expect(policy2.lastCloudCheck).to.be.a('number');

        const { statusCode, body } = await postDapResetStatsAllEncipher();
        expect(statusCode).to.equal(200);

        ({ stdout } = await runDap(['analyze', '-m', DAP_TEST_HOST_MAC]));
        const policy3 = parseDapPolicyFromStdout(stdout);
        expect(policy3.learnedCount).to.equal(0);
        expect(policy3.state).to.equal('learning');
        expect(policy3.lastUpdated).to.be.a('number');
        expect(policy3.lastCloudCheck).to.be.a('number');
      });
    });





    
  });



});
