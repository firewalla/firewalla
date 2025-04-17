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

const cloud = require('../encipher');
const netBot = require("../controllers/netbot.js");
const gid = "3d0a201e-0b2f-**";
const netbot = new netBot(
  { name:"testbot", main:"netbot.js", controller:{type: "netbot", id:0} },
  { service:"test", controllers:[] },
  new cloud("netbot"),
  [], gid, true, true
);
const networkProfile = require('../net2/NetworkProfileManager.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const log = require('../net2/logger.js')(__filename);
const loggerManager = require('../net2/LoggerManager.js')
const { delay } = require('../util/util.js')

async function getMacWithFlow(redisPrefix) {
  const results = await rclient.scanResults(redisPrefix + '*', 10000)
  if (!results.length)
    throw new Error('No device with flow', redisPrefix);
  return results[0].substring(redisPrefix.length);
}

async function getTsFromFlowKey(key) {
  const result = await rclient.zrevrangebyscoreAsync(key, '+inf', 0, 'limit', 0, 1, 'withscores');
  if (result.length < 2)
    throw new Error('No timestamp found for key', key);
  return Math.ceil(result[1])
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

before(async () => {
  loggerManager.setLogLevel('Eptcloud', 'none');
  netbot.networkProfileManager.scheduleRefresh()
  await netbot.hostManager.getHostsAsync()
})

describe('test get flows', function() {
  this.timeout(3000);

  before(async() => {
    networkProfile.networkProfiles = {};
    networkProfile.networkProfiles["1f97bb38-7592-4be0-**"] = {ipv4:"192.168.203.134"};
    // loggerManager.setLogLevel('LogQuery', 'verbose');
    // loggerManager.setLogLevel('FlowTool', 'verbose');
    // loggerManager.setLogLevel('AuditTool', 'verbose');
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

  it('should get common flows', async() => {
    const target = await getMacWithFlow("flow:conn:in:");

    const msg = {data:{item:"flows", count: 2, apiVer: 2}, target};
    let resp = await get(msg)
    expect(resp.count).to.equal(2);

    msg.data.apiVer = 3
    resp = await get(msg)
    expect(resp.count).to.equal(0);

    msg.data.regular = true
    resp = await get(msg)
    expect(resp.count).to.equal(2);
  });

  it('should get audit flows', async() => {
    const target = await getMacWithFlow('audit:drop:');
    const ts = await getTsFromFlowKey('audit:drop:' + target);

    const msg = {data:{item:"flows", audit:true, ts, count: 100, apiVer: 2}, target};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.ltype == 'audit' && !f.local)).to.be.true

    msg.data.apiVer = 3
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.ltype == 'audit' && !f.local)).to.be.true

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
  });

  it('should get DNS flows', async() => {
    const target = await getMacWithFlow('flow:dns:');
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
  });

  it('should get NTP flows', async() => {
    const target = await getMacWithFlow('audit:accept:');
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
  });

  it('should get local flow according to apiVer', async() => {
    const target = await getMacWithFlow('flow:local:');
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
  });

  it('should get local block flow according to apiVer', async() => {
    const target = await getMacWithFlow('audit:local:drop:');
    const ts = await getTsFromFlowKey('audit:local:drop:' + target);

    const msg = {data:{item:"flows", audit:true, ts, apiVer: 2, count: 100}, target};
    let resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.ltype == 'audit' && f.local)).to.be.true

    const ts2 = await getTsFromFlowKey('audit:drop:' + target);
    msg.data.ts = ts2
    resp = await get(msg)
    expect(resp.count).to.be.above(0);
    expect(resp.flows.some(f => f.ltype == 'audit' && !f.local)).to.be.true

    resp = await get({data:{item:"flows", localAudit:true, ts, apiVer: 3, count: 100}, target})
    expect(resp.count).to.be.above(0);
    expect(resp.flows.every(f => f.ltype == 'audit' && f.local)).to.be.true


    const msgAuditLogs = {data:{item:"auditLogs", ts, count: 100, apiVer: 2}, target};
    resp = await get(msgAuditLogs)
    expect(resp.count).to.be.above(0);
    expect(resp.logs.some(f => f.ltype == 'audit' && f.local)).to.be.true

    msgAuditLogs.data.ts = ts2
    resp = await get(msgAuditLogs)
    expect(resp.count).to.be.above(0);
    expect(resp.logs.some(f => f.ltype == 'audit' && !f.local)).to.be.true

    resp = await get({data:{item:"auditLogs", localAudit:true, ts, count: 100, apiVer: 3}, target})
    expect(resp.count).to.be.above(0);
    expect(resp.logs.every(f => f.ltype == 'audit' && f.local)).to.be.true
  });

});

describe('test get stats', function() {
  this.timeout(10000);

  before(async() => {
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

  it('init stats', async() => {
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

  it('get host', async() => {
    // choose the host that has some local drop
    const target = await getMacWithFlow("audit:local:drop:");

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

  it('get intf', async() => {
    // choose the host that has some local drop
    const mac = await getMacWithFlow("audit:local:drop:");
    const host = await netbot.hostManager.getHostAsync(mac)
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
    expect(result).to.be.equal('{"kkk":111}');
  });

  it('should get event message', async() => {
    expect(await netbot.getNotifEvent("phone_paired", 1, {"eid": "7wZYL2pk6hkzF313f8FkIA", "deviceName": "Device-abc"})).to.be.eql({
      "msg": "A new phone (Device-abc) is paired with your Firewalla box.",
      "args": {eid: "7wZYL2pk6hkzF313f8FkIA", deviceName: "Device-abc"},
    })
  });

  it('should notify new event', async() => {
    netbot.hostManager.policy = {"state": true, "phone_paired": true};

    const event = {"ts":1743556883664, "event_type":"action", "action_type":"phone_paired","action_value":1, "labels":{"eid":"7wZYL2pk6hkzF313f8FkIA", "deviceName": "Device-abc"}}
    const payload = await netbot._notifyNewEvent(event);
    expect(payload.type).to.be.equal('FW_NOTIFICATION');
    expect(payload.titleLocalKey).to.be.equal('NEW_EVENT_TITLE_phone_paired');
    expect(payload.bodyLocalMsg).to.be.equal("A new phone (Device-abc) is paired with your Firewalla box.");
    expect(payload.bodyLocalArgs).to.be.eql(["7wZYL2pk6hkzF313f8FkIA", "Device-abc", 0]);
  })
});
