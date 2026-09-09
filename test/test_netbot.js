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

'use strict'

let chai = require('chai');
let expect = chai.expect;
const log = require('../net2/logger.js')(__filename);
const loggerManager = require('../net2/LoggerManager.js')

const cloud = require('../encipher');
const netBot = require("../controllers/netbot.js");
const gid = "3d0a201e-0b2f-**";
const netbot = new netBot(
  { name:"testbot", main:"netbot.js", controller:{type: "netbot", id:0} },
  { service:"test", controllers:[] },
  new cloud("netbot"),
  [], gid, true, true
);
log.info('netbot initialized')
const fireRouter = require('../net2/FireRouter.js');
log.info('firerouter initialized')
const networkProfileManager = require('../net2/NetworkProfileManager.js');
log.info('network profile manager initialized')
const rclient = require('../util/redis_manager.js').getRedisClient();
const sysManager = require('../net2/SysManager.js');
log.info('sys manager initialized')
const { delay } = require('../util/util.js')
const Constants = require('../net2/Constants.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const f = require('../net2/Firewalla.js');

// ctx is the mocha context of the calling test. A box only records the kinds of flow its enabled
// features produce, so a prefix with no data means there is nothing to exercise rather than a
// failure - skip the test instead. ctx.skip() throws, so nothing after the call runs. Callers that
// pass no ctx still get the error.
async function getMacWithFlow(redisPrefix, ctx) {
  let results = await rclient.scanResults(redisPrefix + '*', 10000)
  results = results
    .filter(key => !key.includes(':if:') && !key.endsWith('system'))
    .map(key => key.substring(redisPrefix.length))
    .filter(mac => netbot.hostManager.getHostFastByMAC(mac));
  if (!results.length) {
    if (ctx) ctx.skip();
    throw new Error('No device with flow', redisPrefix);
  }
  return results[0]
}

async function getTsFromFlowKey(key) {
  const result = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'limit', 0, 1, 'withscores');
  if (result.length < 2)
    throw new Error('No timestamp found for key', key);
  return Math.ceil(result[1]) + 1
}

async function call(msg) {
  const request = {
    mtype: "msg",
    message: {
      from: 'firewalla-test',
      obj: msg,
      appInfo: {
        deviceName: 'firewalla-test',
        timezone: 'America/Los_Angeles',
        language: 'en',
      },
      type:"jsondata",
      suppressLog: true,
    },
  }

  const resp = await netbot.msgHandler(gid, request)
  expect(resp.code).to.equal(200, resp.code + " " + resp.message);
  return resp.data
}

async function get(msg) {
  return call(Object.assign({
    mtype: 'get',
    type: 'jsonmsg'
  }, msg))
}

before(async function() {
  this.timeout(10000)
  loggerManager.setLogLevel('Eptcloud', 'none');
  netbot.identityManager.loadIdentityClasses()
  await fireRouter.waitTillReady()
  await sysManager.updateAsync();
  await networkProfileManager.refreshNetworkProfiles(true)
  log.info('network profiles refreshed')
  await netbot.hostManager.getHostsAsync()
  log.info('hosts refreshed')
  for (const ns of Object.keys(netbot.identityManager.nsClassMap))
    await netbot.identityManager.refreshIdentity(ns);

  log.info('netbot before all hook done')
})

describe('test get flows', function() {
  this.timeout(3000);

  before(async function() {
    networkProfileManager.networkProfiles["1f97bb38-7592-4be0-**"] = {ipv4:"192.168.203.134"};
    // loggerManager.setLogLevel('LogQuery', 'verbose');
    // loggerManager.setLogLevel('FlowTool', 'verbose');
    // loggerManager.setLogLevel('AuditTool', 'verbose');
    this.allFlowsData = {
      item:"flows", count:200, apiVer: 3, asc: false,
      regular:true, dns:true, ntp:true, audit:true, local:true, localAudit:true
    }
  });

  after(() => {
    loggerManager.setLogLevel('LogQuery', 'info');
  });


  it('should check log query args', async() => {
    const msg = {data:{item:"flows", type: "tag", audit: true}, target: "av"};
    const options = await netbot.checkLogQueryArgs(msg);
    expect(options.tag).to.be.equal("av");
    expect(options.audit).to.be.equal(true);
  });

  it('should process get flows by interface', async() => {
    const msg = {data:{item:"flows", type: "intf", count: 2}, target: "1f97bb38-7592-4be0-**"};

    const resp = await get(msg)
    expect(resp.count).to.equal(0);
  });

  it('should get common flows', async function() {
    const target = await getMacWithFlow("flow:conn:in:", this);

    const msg = {data:{item:"flows", count: 2, apiVer: 2}, target};
    let resp = await get(msg)
    expect(resp.count).to.equal(2);

    msg.data.apiVer = 3
    resp = await get(msg)
    expect(resp.count).to.equal(0);

    msg.data.regular = true
    resp = await get(msg)
    expect(resp.count).to.equal(2);
    expect(resp.flows.every(f => f.ltype == 'flow' && f.type == 'ip' && !f.local)).to.be.true

    const ts = await getTsFromFlowKey('flow:conn:in:' + target);
    resp = await get({ data:{ ...this.allFlowsData, ts }, target })
    expect(resp.count).to.above(0);
    expect(resp.flows.some(f => f.ltype == 'flow' && f.type == 'ip' && !f.local)).to.be.true
  });

  it('should get audit flows', async function() {
    const target = await getMacWithFlow('audit:drop:', this);
    const ts = await getTsFromFlowKey('audit:drop:' + target);

    const msg = {data:{item:"flows", audit:true, ts, count: 100, apiVer: 2}, target};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.ltype == 'audit' && !f.local)).to.be.true

    msg.data.apiVer = 3
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.ltype == 'audit' && !f.local)).to.be.true

    resp = await get({ data:{ ...this.allFlowsData, ts }, target })
    expect(resp.count).to.above(0);
    expect(resp.flows.some(f => f.ltype == 'audit' && !f.local), `${target} ${ts}/* resp.flows.map(JSON.stringify) */`).to.be.true

    // default true for auditLogs
    const msgAuditLogs = {data:{item:"auditLogs", ts, count: 100, apiVer: 2}, target};
    resp = await get(msgAuditLogs)
    expect(resp.count).to.be.above(0);
    expect(resp.logs.some(f => f.ltype == 'audit' && !f.local)).to.be.true

    msgAuditLogs.data.apiVer = 3
    resp = await get(msgAuditLogs)
    expect(resp.count).to.be.equal(0);

    msgAuditLogs.data.audit = true
    resp = await get(msgAuditLogs)
    expect(resp.count).to.be.above(0);
    expect(resp.logs.every(f => f.ltype == 'audit' && !f.local)).to.be.true

    resp = await get({ data:{ ...this.allFlowsData, ts, item: 'auditLogs' }, target })
    expect(resp.count).to.above(0);
    expect(resp.logs.some(f => f.ltype == 'audit' && !f.local)).to.be.true
  });

  it('should get DNS flows', async function() {
    const target = await getMacWithFlow('flow:dns:', this);
    const ts = await getTsFromFlowKey('flow:dns:' + target);

    const msg = {data:{item:"flows", dnsFlow:true, ts, count: 100, apiVer: 2}, target};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.ltype == 'flow' && f.type == 'dnsFlow')).to.be.true

    msg.data.apiVer = 3
    resp = await get(msg)
    expect(resp.count).to.be.equal(0);

    delete msg.data.dnsFlow
    msg.data.dns = true
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.ltype == 'flow' && f.type == 'dnsFlow')).to.be.true

    resp = await get({ data:{ ...this.allFlowsData, ts }, target })
    expect(resp.count).to.above(0);
    expect(resp.flows.some(f => f.ltype == 'flow' && f.type == 'dnsFlow')).to.be.true
  });

  it('should get NTP flows', async function() {
    const target = await getMacWithFlow('audit:accept:', this);
    const ts = await getTsFromFlowKey('audit:accept:' + target);

    const msg = {data:{item:"flows", ntpFlow:true, ts, count: 100, apiVer: 2}, target};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.ltype == 'flow' && f.type == 'ntp')).to.be.true

    msg.data.apiVer = 3
    resp = await get(msg)
    expect(resp.count).to.be.equal(0);

    delete msg.data.ntpFlow
    msg.data.ntp = true
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.ltype == 'flow' && f.type == 'ntp')).to.be.true

    resp = await get({ data:{ ...this.allFlowsData, ts }, target })
    expect(resp.count).to.above(0);
    expect(resp.flows.some(f => f.ltype == 'flow' && f.type == 'ntp')).to.be.true
  });

  it('should get local flow according to apiVer', async function() {
    const target = await getMacWithFlow('flow:local:', this);
    const ts = await getTsFromFlowKey('flow:local:' + target);

    const msg = {data:{item:"flows", localFlow:true, local:true, ts, apiVer:2, count: 100}, target};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.ltype == 'flow' && f.type == 'ip' && f.local)).to.be.true

    delete msg.data.localFlow
    msg.data.apiVer = 3
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.ltype == 'flow' && f.type == 'ip' && f.local)).to.be.true

    resp = await get({ data:{ ...this.allFlowsData, ts }, target })
    expect(resp.count).to.above(0);
    expect(resp.flows.some(f => f.ltype == 'flow' && f.type == 'ip' && f.local)).to.be.true
  });

  it('should get local block flow according to apiVer', async function() {
    const target = await getMacWithFlow('audit:local:drop:', this);
    const ts = await getTsFromFlowKey('audit:local:drop:' + target);

    const msg = {data:{item:"flows", audit:true, ts, apiVer: 2, count: 100}, target};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.ltype == 'audit' && f.local)).to.be.true

    resp = await get({data:{item:"flows", localAudit:true, ts, apiVer: 3, count: 100}, target})
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.ltype == 'audit' && f.local)).to.be.true

    resp = await get({ data:{ ...this.allFlowsData, ts }, target })
    expect(resp.count).to.above(0);
    expect(resp.flows.some(f => f.ltype == 'audit' && f.local)).to.be.true


    const msgAuditLogs = {data:{item:"auditLogs", ts, count: 100, apiVer: 2}, target};
    resp = await get(msgAuditLogs)
    expect(resp.count).to.be.above(0);
    expect(resp.logs.some(f => f.ltype == 'audit' && f.local)).to.be.true

    resp = await get({data:{item:"auditLogs", localAudit:true, ts, count: 100, apiVer: 3}, target})
    expect(resp.count).to.be.above(0);
    expect(resp.logs.every(f => f.ltype == 'audit' && f.local)).to.be.true

    resp = await get({ data:{ ...this.allFlowsData, ts, item: 'auditLogs' }, target })
    expect(resp.count).to.be.above(0);
    expect(resp.logs.some(f => f.ltype == 'audit' && f.local)).to.be.true
  });

  it('should exclude flows as expected', async function() {
    const target = await getMacWithFlow('flow:conn:in:', this);
    const ts = await getTsFromFlowKey('flow:conn:in:' + target);

    const msg = {data:{item:"flows", audit:true, ts, apiVer: 2, count: 100, exclude: [{device: target}]}, target:'0.0.0.0'};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.device == target)).to.be.false

    Object.assign(msg.data, {regular: true, dns: true, apiVer: 3})
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.device == target)).to.be.false
  });

  it.skip('should include flows as expected', async() => {
    const hosts = await netbot.hostManager.getHostsAsync()
    const target = hosts.filter(h => {
      try {
        const activity = JSON.parse(h.o.recentActivity)
        return activity.ts > Date.now()/1000 - 24*60*60
      } catch(e) {
        return false
      }
    })[0].getGUID()
    expect(target).to.not.be.empty;
    const ts = await getTsFromFlowKey('flow:conn:in:' + target);
    log.info(target, ts)

    const msg = {data:{item:"flows", audit:true, ts, apiVer: 2, count: 2000}, target};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    const flow = resp.flows.find(f => f.category)
    expect(flow, `No flow with category from ${target}`).to.not.be.undefined;

    msg.data.category = flow.category
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.category == flow.category)).to.be.true

    msg.data.category == 'none' // this should be ignored
    Object.assign(msg.data, {
      regular: true, audit: true, dns: true, apiVer: 3,
      include: [ {category: flow.category} ],
    })
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.category == flow.category)).to.be.true

    const auditMsg = {data:{item:"auditLogs", audit:true, ts, apiVer: 2, count: 4000}, target: '0.0.0.0'};
    resp = await get(auditMsg)
    expect(resp.count).to.be.above(0);
    const auditFlow = resp.logs.find(f => f.category)
    expect(auditFlow, `No blocked flow with category from ${target}`).to.not.be.undefined;

    auditMsg.data.category = auditFlow.category
    resp = await get(auditMsg)
    expect(resp.count).to.be.above(0);
    expect(resp.logs.every(f => f.category == auditFlow.category)).to.be.true
  });

});

describe('test system flows', function() {
  this.timeout(10000);

  before(async() => {
    // loggerManager.setLogLevel('LogQuery', 'verbose');
    // loggerManager.setLogLevel('FlowTool', 'debug');
    // loggerManager.setLogLevel('AuditTool', 'verbose');

    this.allSwitches = ['regular', 'dns', 'ntp', 'audit', 'local', 'localAudit'];
  });

  after(() => {
  })

  it('global audit query should return wan blocks', async() => {
    const msg = {data:{item:"flows", audit:true, count: 4000, apiVer: 2}, target: '0.0.0.0'};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.ltype == 'audit' && f.device.startsWith('if:'))).to.be.true

    msg.data.apiVer = 3
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.ltype == 'audit' && f.device.startsWith('if:'))).to.be.true

    const msgAuditLogs = {data:{item:"auditLogs", count: 2000, apiVer: 2}, target: '0.0.0.0'};
    resp = await get(msgAuditLogs)
    expect(resp.count).to.be.above(0);
    expect(resp.logs.some(f => f.ltype == 'audit' && f.device.startsWith('if:'))).to.be.true

    msg.data.apiVer = 3
    resp = await get(msgAuditLogs)
    expect(resp.count).to.be.above(0);
    expect(resp.logs.some(f => f.ltype == 'audit' && f.device.startsWith('if:'))).to.be.true
  })

  it.skip('flows within 15min should be exactly the same', async() => {
    const monitorables = netbot.hostManager.getAllMonitorables();
    const wanInterfaces = sysManager.getWanInterfaces().map(i => `${Constants.NS_INTERFACE}:${i.uuid}`)
    const macs = monitorables.map(m => m.getGUID()).concat(wanInterfaces);

    const msg = {data:{item:"flows", count: 2000, apiVer: 3}, target: '0.0.0.0'};
    for (const asc of [true, false]) {
      msg.data.asc = asc;
      msg.data.ts = Date.now() / 1000
      msg.data.ets = Date.now() / 1000
      if (asc)
        msg.data.ts -= 15 * 60;
      else
        msg.data.ets -= 15 * 60;
      for (const switchName of this.allSwitches) {
        msg.data[switchName] = true;
        const respSystem = await get(msg)
        msg.data.macs = macs
        const respIndiviual = await get(msg)
        delete msg.data.macs
        expect(respSystem.count, switchName).to.equal(respIndiviual.count);
        for (const i in respSystem.flows) {
          const p = respSystem.flows[i]
          const q = respIndiviual.flows[i]
          expect(p.ltype, switchName).to.equal(q.ltype);
          expect(p.type, switchName).to.equal(q.type);
          expect(p.ts, switchName).to.equal(q.ts);
          expect(p.device, switchName).to.equal(q.device);
          expect(p.fd, switchName).to.equal(q.fd);
          expect(p.count, switchName).to.equal(q.count);
          expect(p.type == 'ip' ? p.ip : p.domain, switchName).to.equal(q.type == 'ip' ? q.ip : q.domain);
        }
        msg.data[switchName] = false;
      }

      // all types together
      for (const switchName of this.allSwitches) {
        msg.data[switchName] = true;
      }
      const respSystem = await get(msg)
      msg.data.macs = macs
      const respIndiviual = await get(msg)
      delete msg.data.macs
      expect(respSystem.count).to.equal(respIndiviual.count);
      for (const i in respSystem.flows) {
        const p = respSystem.flows[i]
        const q = respIndiviual.flows[i]
        expect(p.ltype).to.equal(q.ltype);
        expect(p.type).to.equal(q.type);
        expect(p.ts).to.equal(q.ts);
        expect(p.device).to.equal(q.device);
        expect(p.fd).to.equal(q.fd);
        expect(p.count).to.equal(q.count);
        expect(p.type == 'ip' ? p.ip : p.domain).to.equal(q.type == 'ip' ? q.ip : q.domain);
      }
    }
  })

  // this case doesn't work if any of the key is cleaned by count
  // it('flows within 12hr should adds up the same', async() => {
  //   const monitorables = netbot.hostManager.getAllMonitorables();
  //   const wanInterfaces = sysManager.getWanInterfaces().map(i => `${Constants.NS_INTERFACE}:${i.uuid}`)
  //   const macs = monitorables.map(m => m.getGUID()).concat(wanInterfaces);

  //   const msg = {data:{item:"flows", count: 4000, apiVer: 3}, target: '0.0.0.0'};
  //   for (const asc of [true, false]) {
  //     msg.data.asc = asc;
  //     msg.data.ts = Date.now() / 1000
  //     msg.data.ets = Date.now() / 1000
  //     if (asc)
  //       msg.data.ts -= 12 * 60 * 60;
  //     else
  //       msg.data.ets -= 12 * 60 * 60;
  //     for (const switchName of this.allSwitches) {
  //       msg.data[switchName] = true;
  //       const respSystem = await get(msg)
  //       msg.data.macs = macs
  //       const respIndiviual = await get(msg)
  //       delete msg.data.macs
  //       const pCount = respSystem.flows.reduce((sum, p) => sum + p.count, 0);
  //       const qCount = respIndiviual.flows.reduce((sum, q) => sum + q.count, 0);
  //       log.info(switchName, msg.data.ts, msg.data.ets, pCount, qCount)
  //       expect(pCount, switchName).to.equal(qCount);
  //       msg.data[switchName] = false;
  //     }
  //   }

  //   for (const switchName of this.allSwitches) {
  //     msg.data[switchName] = true;
  //   }
  //   let respSystem = await get(msg)
  //   msg.data.macs = macs
  //   let respIndiviual = await get(msg)
  //   delete msg.data.macs
  //   let pCount = respSystem.flows.reduce((sum, p) => sum + p.count, 0);
  //   let qCount = respIndiviual.flows.reduce((sum, q) => sum + q.count, 0);
  //   log.info('all', msg.data.ts, msg.data.ets, pCount, qCount)
  //   expect(pCount).to.equal(qCount);
  // })
})

describe('test get stats', function() {
  this.timeout(10000);

  before(async function() {
    // loggerManager.setLogLevel('HostManager', 'verbose');
    // loggerManager.setLogLevel('NetBotTool', 'verbose');
    this.tsKeys = ["newLast24", "last60", "last30", "last12Months"]
    this.switchMetricMap = {
      'regular': ['upload', 'download', 'conn'],
      'dns': ['dns'],
      'ntp': ['ntp'],
      'audit': ['ipB', 'dnsB'],
      'local': ['intra:lo', 'conn:lo:intra', 'upload:lo', 'download:lo', 'conn:lo:in', 'conn:lo:out'],
      'localAudit': ['ipB:lo:intra', 'ipB:lo:in', 'ipB:lo:out'],
    }
    this.switchFlowsMap = {
      'regular': ['upload', 'download'],
      'dns': [],
      'ntp': [],
      'audit': ['ipB:in', 'ipB:out', /* 'ifB:out', */ 'dnsB'], // not checking ifB:out
      'local': ['local:upload', 'local:download', 'local:in', 'local:out'],
      'localAudit': ['local:ipB:in', 'local:ipB:out'],
    }
    log.info('waiting 3 seconds for network profiles to be loaded...')
    await delay(3000)
  });

  after(() => {
    loggerManager.setLogLevel('LogQuery', 'info');
  });

  it('init stats', async function() {
    // one full init per entry in switchMetricMap, plus one for apiVer 2. each is a complete
    // "load init data" in netbot and costs over a second on a gold box, ~10.5s in total, so this
    // needs its own budget rather than the 10s the suite gives every other test. the cost grows
    // with the amount of data on the box
    this.timeout(30000)
    let v3TS = {}
    let resp
    for (const s in this.switchMetricMap) {
      resp = await call({mtype: 'init', type:'jsonmsg', data:{apiVer: 3, stats: {[s]: true}}})
      expect(resp).to.not.have.property('systemFlows')
      for (const ts of this.tsKeys) {
        for (const ss in this.switchMetricMap) {
          for (const m of this.switchMetricMap[ss]) {
            // log.info('init v3', s, ts, m, [> resp[ts] <])
            if (ss != s || s.startsWith('local') && !m.startsWith('intra') && !m.endsWith('intra')) {
              expect(resp[ts], `v3: should not have ${m} in ${ts} when ${s} is not set`).to.not.have.property(m)
            } else {
              expect(resp[ts], `v3: should have ${m} in ${ts} when ${s} is set`).to.have.property(m)
            }
          }
        }
        // save to verify v2 results sum the same
        if (s == 'audit') v3TS[ts] = resp[ts]
        if (s == 'localAudit') Object.assign(v3TS[ts], resp[ts])
      }
    }

    resp = await call({mtype:'init', type:'jsonmsg', data:{apiVer: 2, local: true}})
    expect(resp).to.have.property('systemFlows')

    for (const ts of this.tsKeys) {
      for (const s in this.switchMetricMap) {
        for (const m of this.switchMetricMap[s]) {
          // log.info('init v2', s, ts, m, [> resp[ts] <])
          if (s == 'localAudit' || s == 'local' && !m.startsWith('intra') && !m.endsWith('intra')) {
            expect(resp[ts], `v3: should not have ${m} in ${ts} when ${s} is not set`).to.not.have.property(m)
          } else {
            expect(resp[ts], `v3: should have ${m} in ${ts} when ${s} is set`).to.have.property(m)
          }
        }
      }
      expect(resp[ts].totalIpB, ts).to.be.equal(v3TS[ts].totalIpB + v3TS[ts]['totalIpB:lo:intra'])
    }
  });

  it('get host', async function() {
    // choose the host that has some local drop
    const target = await getMacWithFlow("audit:local:drop:", this);

    let resp, v3TS = {}
    for (const s in this.switchMetricMap) {
      resp = await get({data:{item: 'host', apiVer: 3, [s]: true}, target})
      for (const ts of this.tsKeys) {
        for (const ss in this.switchMetricMap) {
          for (const m of this.switchMetricMap[ss]) {
            // log.info('get host v3', s, ts, m, [> resp[ts] <])
            if (ss != s || s.startsWith('local') && (m.startsWith('intra') || m.endsWith('intra'))) {
              expect(resp[ts], `v3: should not have ${m} in ${ts} when ${s} is not set`).to.not.have.property(m)
            } else {
              expect(resp[ts], `v3: should have ${m} in ${ts} when ${s} is set`).to.have.property(m)
            }
          }
        }
        // save to verify v2 results sum the same
        if (s == 'audit') v3TS[ts] = resp[ts]
        if (s == 'localAudit') Object.assign(v3TS[ts], resp[ts])
      }

      if (!this.switchFlowsMap[s].length) continue
      expect(resp, Object.keys(resp)).to.have.property('flows')
      for (const ss in this.switchFlowsMap) {
        for (const m of this.switchFlowsMap[ss]) {
          // log.info('get host v3', s, ts, m, [> resp[ts] <])
          if (ss != s) {
            expect(resp.flows, `v3: should not have ${m} in flows when ${s} is not set`).to.not.have.property(m)
          } else {
            expect(resp.flows, `v3: should have ${m} in flows when ${s} is set`).to.have.property(m)
          }
        }
      }
    }

    resp = await get({data:{item: 'host', apiVer: 2, local: true}, target})

    for (const ts of this.tsKeys) {
      for (const s in this.switchMetricMap) {
        for (const m of this.switchMetricMap[s]) {
          // log.info('get host v2', s, ts, m, [> resp[ts] <])
          if (s == 'localAudit' || s == 'local' && (m.startsWith('intra') || m.endsWith('intra'))) {
            expect(resp[ts], `v2: should not have ${m} in ${ts} when ${s} is not set`).to.not.have.property(m)
          } else {
            expect(resp[ts], `v2: should have ${m} in ${ts} when ${s} is set`).to.have.property(m)
          }
        }
      }
      for (const s in this.switchFlowsMap) {
        for (const m of this.switchFlowsMap[s]) {
          // log.info('get host v3', s, ts, m, [> resp[ts] <])
          expect(resp.flows, `v2: should have ${m} in flows when ${s} is set`).to.have.property(m)
        }
      }
    }
  });

  it('get intf', async function() {
    // choose the host that has some local drop
    const mac = await getMacWithFlow("audit:local:drop:", this);
    const host = await netbot.hostManager.getIdentityOrHost(mac)
    const target = host.o.intf

    let resp, v3TS = {}
    for (const s in this.switchMetricMap) {
      resp = await get({data:{item: 'intf', apiVer: 3, [s]: true}, target})
      for (const ts of this.tsKeys) {
        for (const ss in this.switchMetricMap) {
          for (const m of this.switchMetricMap[ss]) {
            // log.info('get intf v3', s, ts, m, [> resp[ts] <])
            if (ss != s) {
              expect(resp[ts], `v3: should not have ${m} in ${ts} when ${s} is not set`).to.not.have.property(m)
            } else {
              expect(resp[ts], `v3: should have ${m} in ${ts} when ${s} is set`).to.have.property(m)
            }
          }
        }
        // save to verify v2 results sum the same
        if (s == 'audit') v3TS[ts] = resp[ts]
        if (s == 'localAudit') Object.assign(v3TS[ts], resp[ts])
      }
      if (!this.switchFlowsMap[s].length) continue
      expect(resp, Object.keys(resp)).to.have.property('flows')
      for (const ss in this.switchFlowsMap) {
        for (const m of this.switchFlowsMap[ss]) {
          // log.info('get intf v3', s, ts, m, [> resp[ts] <])
          if (ss != s) {
            expect(resp.flows, `v3: should not have ${m} in flows when ${s} is not set`).to.not.have.property(m)
          } else {
            expect(resp.flows, `v3: should have ${m} in flows when ${s} is set`).to.have.property(m)
          }
        }
      }
    }

    resp = await get({data:{item: 'intf', apiVer: 2, local: true}, target})

    for (const ts of this.tsKeys) {
      for (const s in this.switchMetricMap) {
        for (const m of this.switchMetricMap[s]) {
          // log.info('get intf v2', s, ts, m, [> resp[ts] <])
          if (s == 'localAudit') {
            expect(resp[ts], `v2: should not have ${m} in ${ts} when ${s} is not set`).to.not.have.property(m)
          } else {
            expect(resp[ts], `v2: should have ${m} in ${ts} when ${s} is set`).to.have.property(m)
          }
        }
      }
      for (const s in this.switchFlowsMap) {
        for (const m of this.switchFlowsMap[s]) {
          // log.info('get intf v3', s, ts, m, [> resp[ts] <])
          expect(resp.flows, `v2: should have ${m} in flows when ${s} is set`).to.have.property(m)
        }
      }
    }
  });
});

describe('test netbot', function(){
  before( async() => {
    await rclient.saddAsync('sys:eid:blacklist', 'test-eid1');
    await rclient.hsetAsync("sys:ept:memberNames", "7wZYL2pk6hkzF313f8FkIA", "Device-abc");
    await rclient.saddAsync("sys:ept:members", '{"name":"my1@firewalla.com","eid":"7wZYL2pk6hkzF313f8FkIA"}')
  });

  after(async() => {
    await rclient.sremAsync('sys:eid:blacklist', 'test-eid1');
    await rclient.hdelAsync("sys:ept:memberNames", "7wZYL2pk6hkzF313f8FkIA");
    await rclient.sremAsync("sys:ept:members", '{"name":"my1@firewalla.com","eid":"7wZYL2pk6hkzF313f8FkIA"}')
  });

  it('should test eid acl', async() => {
    const rawmsg = {"mtype":"msg","message":{"type":"jsondata","appInfo":{"eid":"test-eid1", "platform": "ios"},"obj":{"mtype":"cmd","data":{},"type":"jsonmsg"}},"target":"1f97bb38-7592-4be0"};
    const response = await netbot.msgHandler(gid, rawmsg)
    expect(response.code).to.equal(403);
    log.debug("eid acl response", response);
  });

  it('should record msg data', async() => {
    await netbot._precedeRecord("FFFF056-5ECD-4F93-9201-AFFF7EC", {kkk: 111});
    const result = await rclient.getAsync("_hx:msg:FFFF056-5ECD-4F93-9201-AFFF7EC");
    expect(result).to.be.equal('{"origin":{"kkk":111}}');
  });

  it('should get event message', async() => {
    expect(await netbot.getNotifEvent("phone_paired", 1, {"eid": "7wZYL2pk6hkzF313f8FkIA", "name": "my1@firewalla.com", "dName": "Device-abc", "ts": 1743556883664})).to.be.eql({
      "msg": "A new phone (Device-abc) is paired with your Firewalla box.",
      "args": {eid: "7wZYL2pk6hkzF313f8FkIA", dName: "Device-abc", deviceName: "Device-abc", name: "my1@firewalla.com", ts: 1743556883664},
      "localArgs": ["7wZYL2pk6hkzF313f8FkIA", "Device-abc", 1743556883664, "my1@firewalla.com"],
    })
  });

  it('should get event message of legacy phone_paired labels', async() => {
    expect(await netbot.getNotifEvent("phone_paired", 1, {"eid": "7wZYL2pk6hkzF313f8FkIA", "deviceName": "Device-abc"})).to.be.eql({
      "msg": "A new phone (Device-abc) is paired with your Firewalla box.",
      "args": {eid: "7wZYL2pk6hkzF313f8FkIA", dName: "Device-abc", deviceName: "Device-abc", name: "", ts: 0},
      "localArgs": ["7wZYL2pk6hkzF313f8FkIA", "Device-abc", 0, ""],
    })
  });

  it('should get event message without device name', async() => {
    const payload = await netbot.getNotifEvent("phone_paired", 1, {"eid": "7wZYL2pk6hkzF313f8FkIA", "name": "my1@firewalla.com", "ts": 1743556883664});
    expect(payload.msg).to.be.equal("A new phone is paired with your Firewalla box.");
    expect(payload.localArgs).to.be.eql(["7wZYL2pk6hkzF313f8FkIA", "", 1743556883664, "my1@firewalla.com"]);
  });

  it('should not get event message of unsupported event type', async() => {
    const payload = await netbot.getNotifEvent("no_such_event", 1, {});
    expect(payload.msg).to.be.equal('');
  });

  it('should notify new event', async () => {
    netbot.hostManager.policy = {"notify": { "state": true, "phone_paired": true }};

    const event = { "ts": 1743556883664, "event_type": "action", "action_type": "phone_paired", "action_value": 1, "labels": { "eid": "7wZYL2pk6hkzF313f8FkIA", "name": "my1@firewalla.com", "dName": "Device-abc", "ts": 1743556883664 } }
    const payload = await netbot._notifyNewEvent(event);
    expect(payload.type).to.be.equal('FW_NOTIFICATION');
    expect(payload.titleLocalKey).to.be.equal('NEW_EVENT_TITLE_phone_paired');
    expect(payload.bodyLocalMsg).to.be.equal("A new phone (Device-abc) is paired with your Firewalla box.");
    expect(payload.bodyLocalArgs).to.be.eql(["7wZYL2pk6hkzF313f8FkIA", "Device-abc", 1743556883664, "my1@firewalla.com"]);
    expect(payload.payload.dName).to.be.equal("Device-abc");
    expect(payload.payload.name).to.be.equal("my1@firewalla.com");
  });

  it('should not notify new event if policy is not set', async () => {
    const event = { "ts": 1743556883664, "event_type": "action", "action_type": "phone_paired", "action_value": 1, "labels": { "eid": "7wZYL2pk6hkzF313f8FkIA", "dName": "Device-abc" } }
    netbot.hostManager.policy = {};
    const payload = await netbot._notifyNewEvent(event);
    expect(payload).to.be.undefined;
  });

  it('should notify new event if event type switch is not set', async () => {
    const event = { "ts": 1743556883664, "event_type": "action", "action_type": "phone_paired", "action_value": 1, "labels": { "eid": "7wZYL2pk6hkzF313f8FkIA", "dName": "Device-abc" } }
    netbot.hostManager.policy = {"notify": { "state": true }};
    const payload = await netbot._notifyNewEvent(event);
    expect(payload.type).to.be.equal('FW_NOTIFICATION');
  });

  it('should not notify new event if policy is turned off', async () => {
    const event = { "ts": 1743556883664, "event_type": "action", "action_type": "phone_paired", "action_value": 1, "labels": { "eid": "7wZYL2pk6hkzF313f8FkIA", "dName": "Device-abc" } }
    netbot.hostManager.policy = {"notify": { "state": true, "phone_paired": false }};
    const payload = await netbot._notifyNewEvent(event);
    expect(payload).to.be.undefined;
  });

  it('should check event notify policy', async () => {
    expect(netbot._checkEventNotifyPolicy({}, "test")).to.be.false;
    expect(netbot._checkEventNotifyPolicy({ "notify": {} }, "test")).to.be.false;
    expect(netbot._checkEventNotifyPolicy({ "notify": { "state": 1 } }, "test")).to.be.false;
    expect(netbot._checkEventNotifyPolicy({ "notify": { "state": 1, "test": true } }, "test")).to.be.true;
  });

  it('should check event notify policy of default on event type', async () => {
    // global switch always wins, an unset one is taken as off
    expect(netbot._checkEventNotifyPolicy({}, "phone_paired")).to.be.false;
    expect(netbot._checkEventNotifyPolicy({ "notify": {} }, "phone_paired")).to.be.false;
    // notification of phone_paired is on unless it is explicitly turned off
    expect(netbot._checkEventNotifyPolicy({ "notify": { "state": 1 } }, "phone_paired")).to.be.true;
    expect(netbot._checkEventNotifyPolicy({ "notify": { "state": 1, "phone_paired": true } }, "phone_paired")).to.be.true;
    expect(netbot._checkEventNotifyPolicy({ "notify": { "state": 1, "phone_paired": false } }, "phone_paired")).to.be.false;
    expect(netbot._checkEventNotifyPolicy({ "notify": { "state": 1, "phone_paired": 0 } }, "phone_paired")).to.be.false;
    expect(netbot._checkEventNotifyPolicy({ "notify": { "state": false } }, "phone_paired")).to.be.false;
    expect(netbot._checkEventNotifyPolicy({ "notify": { "state": 0 } }, "phone_paired")).to.be.false;
  });

});

describe('test familyDnsTest', function() {
  this.timeout(30000);

  before(async function() {
    const sl = require('../sensor/APISensorLoader.js');
    await sl.initSensors(netbot.eptcloud);
    sl.run();
  });

  async function dnsTest(value) {
    return call({ mtype: 'cmd', type: 'jsonmsg', data: { item: 'familyDnsTest', value }, target: '0.0.0.0' });
  }

  async function dnsTestRaw(value) {
    return netbot.msgHandler(gid, {
      mtype: 'msg',
      message: { from: 'test', obj: { mtype: 'cmd', type: 'jsonmsg', data: { item: 'familyDnsTest', value }, target: '0.0.0.0' }, appInfo: { deviceName: 'test' }, type: 'jsondata', suppressLog: true }
    });
  }

  it('should return results for valid servers and domains', async () => {
    const resp = await dnsTest({ servers: ['8.8.8.8'], domains: ['www.google.com'] });
    expect(resp).to.be.an('array').with.lengthOf(1);
    expect(resp[0].server).to.equal('8.8.8.8');
    expect(resp[0].results[0].domain).to.equal('www.google.com');
    expect(resp[0].results[0].addresses).to.be.an('array').that.is.not.empty;
  });

  it('should reject when servers is missing', async () => {
    const resp = await dnsTestRaw({ domains: ['www.google.com'] });
    expect(resp.code).to.equal(500);
    expect(resp.message).to.include('servers is required');
  });

  it('should reject when domains is missing', async () => {
    const resp = await dnsTestRaw({ servers: ['8.8.8.8'] });
    expect(resp.code).to.equal(500);
    expect(resp.message).to.include('domains is required');
  });

  it('should reject when servers exceeds limit', async () => {
    const resp = await dnsTestRaw({ servers: Array(11).fill('8.8.8.8'), domains: ['www.google.com'] });
    expect(resp.code).to.equal(500);
    expect(resp.message).to.include('exceeds limit');
  });
});

// Handlers that hand a caller supplied value to a program:
//   cmdHandler     item "apt-get"     -> scripts/apt-get.sh
//   boneMsgHandler control "script"   -> scripts/<name>
//
// No real script runs: getFirewallaHome() is pointed at a temp tree of recorders that write their
// argv to a file and print nothing. Printing nothing keeps the apt-get handler's
// `sudo tee -a /var/log/fwapt.log` branch from firing, so the test leaves no trace in the system log.
describe('test netbot handlers that run a program', function() {
  this.timeout(20000);

  let home, record, realGetFirewallaHome;

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'netbot-ctl-'));
    record = path.join(home, 'argv');
    fs.mkdirSync(path.join(home, 'scripts'));
    for (const name of ['apt-get.sh', 'diag.sh']) {
      const p = path.join(home, 'scripts', name);
      // argv only, one entry per line, nothing on stdout
      fs.writeFileSync(p, `#!/bin/bash\nprintf '[%s]\\n' "$@" > ${record}\n`);
      fs.chmodSync(p, 0o755);
    }
    realGetFirewallaHome = f.getFirewallaHome;
    f.getFirewallaHome = () => home;
  });

  after(async () => {
    f.getFirewallaHome = realGetFirewallaHome;
    fs.rmdirSync(home, {recursive: true});
  });

  beforeEach(async () => {
    if (fs.existsSync(record)) fs.unlinkSync(record);
  });

  // what the recorder captured, or null when it never ran
  const argv = () => fs.existsSync(record)
    ? fs.readFileSync(record, 'utf8').trim().split('\n').map(l => l.replace(/^\[(.*)\]$/, '$1'))
    : null;

  const aptGet = (value) => netbot.cmdHandler(gid, {data: {item: 'apt-get', value}});

  const cloudScript = async (command, args) => {
    const msg = {type: 'CONTROL', control: 'script', command};
    if (args !== undefined) msg.args = args;
    netbot.boneMsgHandler(msg);
    // the handler does not await execFile, so wait for the recorder or give up. a run that is
    // expected to be refused waits out the whole budget, so keep it short - a run that does happen
    // lands in about 60ms on a gold box, which leaves plenty of margin
    for (let i = 0; i < 20 && !fs.existsSync(record); i++) await delay(50);
  };

  describe('cmdHandler item "apt-get"', function() {

    it('passes the action and packages as separate arguments', async () => {
      await aptGet({action: 'install curl'});
      expect(argv()).to.deep.equal(['install', 'curl']);
    });

    it('puts the flags before the action', async () => {
      await aptGet({action: 'install curl', noUpdate: true, noReboot: true, forceReboot: true});
      expect(argv()).to.deep.equal(['-nu', '-nr', '-fr', 'install', 'curl']);
    });

    it('accepts a versioned and architecture qualified package name', async () => {
      await aptGet({action: 'purge libssl1.1:amd64'});
      expect(argv()).to.deep.equal(['purge', 'libssl1.1:amd64']);
    });

    // a newline is just whitespace to the tokeniser. it never reaches a shell, so the only
    // question is whether the words around it are a valid action and package names
    it('treats a newline as whitespace rather than a command separator', async () => {
      await aptGet({action: 'install pkg\nid'});
      expect(argv()).to.deep.equal(['install', 'pkg', 'id']);
    });

    // execPreUpgrade and execPostUpgrade used to become `-pre <command>` / `-pst <command>`, and
    // apt-get.sh runs those unquoted as root. netbot no longer reads either field.
    it('ignores execPreUpgrade and execPostUpgrade', async () => {
      await aptGet({
        action: 'upgrade',
        execPreUpgrade: 'touch /tmp/fw-test-pre-should-not-exist',
        execPostUpgrade: 'touch /tmp/fw-test-post-should-not-exist',
      });
      expect(argv()).to.deep.equal(['upgrade']);
      expect(fs.existsSync('/tmp/fw-test-pre-should-not-exist')).to.be.false;
      expect(fs.existsSync('/tmp/fw-test-post-should-not-exist')).to.be.false;
    });

    const badAction = {
      'install pkg; id': /^Invalid package name/,
      'install $(id)': /^Invalid package name/,
      'install `id`': /^Invalid package name/,
      'install pkg && id': /^Invalid package name/,
      'install pkg|tee /tmp/x': /^Invalid package name/,
      'install pkg\ntouch /tmp/x': /^Invalid package name/,
      'install ../../etc/passwd': /^Invalid package name/,
      // apt options are refused too: -o DPkg::Pre-Invoke runs a command through apt itself
      'install -o DPkg::Pre-Invoke::=id': /^Invalid package name/,
      'install --reinstall curl': /^Invalid package name/,
      '; id': /^Unsupported apt-get action/,
      'source curl': /^Unsupported apt-get action/,
      'download pkg': /^Unsupported apt-get action/,
    };

    for (const [action, message] of Object.entries(badAction)) {
      it(`rejects action ${JSON.stringify(action)}`, async () => {
        let err = null;
        try {
          await aptGet({action});
        } catch (e) {
          err = e;
        }
        expect(err, 'should have thrown').to.be.an('error');
        expect(err.message).to.match(message);
        expect(argv(), 'the script must not have run').to.be.null;
      });
    }

    for (const value of [{}, {action: ''}, {action: 42}, {action: ['install', 'curl']}]) {
      it(`rejects value ${JSON.stringify(value)}`, async () => {
        let err = null;
        try {
          await aptGet(value);
        } catch (e) {
          err = e;
        }
        expect(err, 'should have thrown').to.be.an('error');
        expect(argv(), 'the script must not have run').to.be.null;
      });
    }
  });

  describe('boneMsgHandler control "script"', function() {

    it('runs a script that lives under scripts/', async () => {
      await cloudScript('diag.sh');
      expect(argv()).to.deep.equal(['']);
    });

    it('passes the rest of the command as arguments', async () => {
      await cloudScript('diag.sh --full -v');
      expect(argv()).to.deep.equal(['--full', '-v']);
    });

    // Without msg.args the command is split on whitespace, which cannot represent a quoted
    // argument - a shell used to do that. Documented here so the limitation is not rediscovered:
    // senders that need spaces in an argument must use the argv form above.
    it('cannot carry a quoted argument in the legacy string form', async () => {
      await cloudScript('diag.sh "foo bar"');
      expect(argv()).to.deep.equal(['"foo', 'bar"']);
    });

    // With msg.args present, command is the bare script name and the arguments are taken verbatim
    // from the array. This is the form that survives quoting: the whitespace split below cannot
    // carry an argument that contains a space.
    describe('argv form (msg.args)', function() {

      it('keeps an argument that contains a space intact', async () => {
        await cloudScript('diag.sh', ['foo bar']);
        expect(argv()).to.deep.equal(['foo bar']);
      });

      it('passes several arguments verbatim, including ones a shell would have eaten', async () => {
        await cloudScript('diag.sh', ['a b', '--msg=x y', "it's", '"quoted"']);
        expect(argv()).to.deep.equal(['a b', '--msg=x y', "it's", '"quoted"']);
      });

      it('accepts an empty array as no arguments', async () => {
        await cloudScript('diag.sh', []);
        expect(argv()).to.deep.equal(['']);
      });

      it('coerces non-string entries, since execFile requires strings', async () => {
        await cloudScript('diag.sh', [1, true]);
        expect(argv()).to.deep.equal(['1', 'true']);
      });

      it('refuses a non-array args', async () => {
        await cloudScript('diag.sh', 'notanarray');
        expect(argv(), 'nothing should have run').to.be.null;
      });

      it('refuses a command that is not a bare script name when args is given', async () => {
        await cloudScript('diag.sh --full', ['x']);
        expect(argv(), 'nothing should have run').to.be.null;
      });

      it('still refuses a script name that could leave scripts/', async () => {
        await cloudScript('../../../bin/sh', ['-c', 'id']);
        expect(argv(), 'nothing should have run').to.be.null;
      });
    });

    // The command used to be concatenated onto the scripts/ path and run through a shell. A
    // metacharacter that is its own word no longer separates anything: execFile passes it to the
    // script as an inert argument, so the marker below is never created.
    const inert = {
      'diag.sh ; touch MARKER': [';', 'touch', 'MARKER'],
      'diag.sh && touch MARKER': ['&&', 'touch', 'MARKER'],
      'diag.sh | tee MARKER': ['|', 'tee', 'MARKER'],
      'diag.sh $(touch MARKER)': ['$(touch', 'MARKER)'],
    };

    for (const [template, expected] of Object.entries(inert)) {
      it(`passes ${JSON.stringify(template)} through as arguments without a shell`, async () => {
        const marker = path.join(home, 'shell_ran');
        await cloudScript(template.replace(/MARKER/g, marker));
        expect(argv()).to.deep.equal(expected.map(a => a.replace(/MARKER/g, marker)));
        expect(fs.existsSync(marker), 'no shell should have interpreted the argument').to.be.false;
      });
    }

    // here the metacharacter is attached to the script token, so the name itself is refused
    const badCommand = [
      'diag.sh; id',
      'diag.sh&&id',
      '$(id)',
      '`id`',
      '../../../bin/sh',
      '/bin/sh',
      'sub/dir.sh',
      '.',
      '..',
      '-rf',
      '',
    ];

    for (const command of badCommand) {
      it(`refuses to run ${JSON.stringify(command)}`, async () => {
        await cloudScript(command);
        expect(argv(), 'nothing should have run').to.be.null;
      });
    }

    it('does not run anything when command is missing', async () => {
      await cloudScript(undefined);
      expect(argv()).to.be.null;
    });
  });
});
