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

const LAN_DEVICE = '192.168.1.10';
// the same device after it changed its IP
const LAN_DEVICE_NEW_IP = '192.168.1.11';
const REMOTE = '203.0.113.5';
const DEVICE_MAC = 'AA:BB:CC:DD:EE:01';

// alarms SuricataDetect handed to the alarm manager
let alarms = [];
// rules SuricataDetect saved for blocked servers
let savedRules = [];
// the callback SuricataDetect registered for new eve.json lines
let onLine;
let mock;
let cacheSnapshot;
let suricataDetect;

function setupMocks() {
  mock = require('mock-require');
  cacheSnapshot = new Set(Object.keys(require.cache));

  mock('../net2/logger.js', () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} }));
  mock('../util/LogReader.js', class LogReader {
    on(event, callback) { onLine = callback; }
    watch() {}
  });
  mock('../net2/SysManager.js', { isLocalIP: (ip) => ip === LAN_DEVICE || ip === LAN_DEVICE_NEW_IP });
  mock('../net2/HostManager.js', class HostManager {
    async getIdentityOrHost() {
      return { getReadableName: () => 'Test Laptop', getNicUUID: () => 'intf-1', getGUID: () => DEVICE_MAC };
    }
  });
  mock('../net2/DNSTool.js', class DNSTool {
    async getDns() { return 'bad.example.com'; }
  });
  mock('../alarm/Alarm.js', {
    SuricataNoticeAlarm: class SuricataNoticeAlarm {
      constructor(timestamp, device, payload) { Object.assign(this, payload); }
    }
  });
  mock('../alarm/Policy.js', class Policy {
    constructor(raw) { Object.assign(this, raw); }
    isZssidsBlock() { return this.zssidsBlock == "1"; }
  });
  mock('../alarm/PolicyManager2.js', class PolicyManager2 {
    // like the real one: looks for the same rule (Policy.isEqual compares no device IP), then saves after a round trip to redis
    async checkAndSaveAsync(policy) {
      const same = savedRules.find(r => r.target === policy.target && r.remotePort === policy.remotePort &&
        r.protocol === policy.protocol && String(r.scope) === String(policy.scope) && r.zssidsBlock === policy.zssidsBlock);
      await new Promise(resolve => setTimeout(resolve, 5));
      if (same) return { policy: same, alreadyExists: 'duplicated' };
      savedRules.push(policy);
      policy.pid = String(100 + savedRules.length);
      return { policy };
    }
    async updatePolicyAsync(update) {
      Object.assign(savedRules.find(r => r.pid === update.pid), update);
    }
  });
  mock('../alarm/AlarmManager2.js', class AlarmManager2 {
    enqueueAlarm(alarm) { alarms.push(alarm); }
  });
  mock('../util/util.js', { getPreferredName: () => 'Test Laptop' });
  mock('../net2/Conntrack.js', { getConnEntry: async () => null });
  mock('../net2/config.js', { isFeatureOn: () => true });
  mock('../net2/HostTool.js', class HostTool {
    async isRecordingOn() { return true; }
  });
}

function teardownMocks() {
  mock.stopAll();
  for (const key of Object.keys(require.cache)) {
    if (!cacheSnapshot.has(key))
      delete require.cache[key];
  }
}

// an eve.json record of a rule that matched the first packets of a connection, so its source is the side that opened it
function eveRecord(options) {
  const signature = JSON.stringify({
    description: '{{SRC}} accessed site {{DST}}, which is identified as a network trojan.',
    srcOrig: true,
    alarmData: { classtype: 'trojan-activity', classtypeDesc: 'a network trojan', cause: 'TEST' }
  });
  const record = {
    timestamp: '2026-11-16T06:00:00.000000+0000',
    event_type: options.eventType || 'alert',
    proto: 'TCP',
    alert: { action: options.action, gid: 1, signature_id: options.sid, rev: 1, signature, category: 'A Network Trojan was detected', severity: 1 }
  };
  if (options.deviceIsClient) {
    record.src_ip = options.deviceIP || LAN_DEVICE;
    record.src_port = 51000;
    record.dest_ip = REMOTE;
    record.dest_port = options.serverPort || 80;
    record.direction = 'to_server';
  } else {
    record.src_ip = REMOTE;
    record.src_port = 51000;
    record.dest_ip = options.deviceIP || LAN_DEVICE;
    record.dest_port = options.serverPort || 80;
    record.direction = 'to_server';
  }
  return record;
}

describe('SuricataDetect', function () {
  before(() => {
    setupMocks();
    suricataDetect = require('../net2/SuricataDetect.js');
  });

  after(() => {
    teardownMocks();
  });

  beforeEach(() => {
    alarms = [];
    savedRules = [];
  });

  it('reports an allowed alert as allowed', async () => {
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1001, action: 'allowed', deviceIsClient: true }));
    expect(alarms.length).to.equal(1);
    expect(alarms[0]['p.ips.action']).to.equal('allowed');
    expect(alarms[0]['p.dest.ip']).to.equal(REMOTE);
    expect(savedRules.length).to.equal(0);
    expect(alarms[0]).to.not.have.property('result');
  });

  it('saves a rule for the server the engine blocked and links it on the alarm as an auto block', async () => {
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1002, action: 'blocked', deviceIsClient: true }));
    expect(savedRules.length).to.equal(1);
    const rule = savedRules[0];
    expect(rule).to.include({
      type: 'ip', target: REMOTE, remotePort: '80', protocol: 'tcp', direction: 'outbound', action: 'block',
      method: 'auto', zssidsBlock: '1', zssidsDeviceIPs: LAN_DEVICE
    });
    // kept until the user undoes it
    expect(rule).to.not.have.property('expire');
    expect(rule).to.not.have.property('autoDeleteWhenExpires');
    expect(rule.scope).to.deep.equal([DEVICE_MAC]);

    expect(alarms.length).to.equal(1);
    expect(alarms[0]['p.ips.action']).to.equal('blocked');
    expect(alarms[0]).to.include({ result: 'block', result_method: 'auto', result_policy: rule.pid });
    // not the cloud auto block, which would turn into a global rule for the domain
    expect(alarms[0]).to.not.have.property('p.action.block');
    expect(alarms[0]['p.local_is_client']).to.equal('1');
  });

  it('works out that the device opened the connection when the rule matched the server reply', async () => {
    // a to_client rule: eve's src is the server that sent the reply, the signature does not say srcOrig
    const record = eveRecord({ sid: 1013, action: 'blocked', deviceIsClient: false });
    const signature = JSON.parse(record.alert.signature);
    delete signature.srcOrig;
    record.alert.signature = JSON.stringify(signature);
    record.direction = 'to_client';

    await suricataDetect.processAlertEvent(record);
    expect(alarms.length).to.equal(1);
    expect(alarms[0]).to.include({ 'p.device.ip': LAN_DEVICE, 'p.dest.ip': REMOTE, 'p.local_is_client': '1' });
    expect(savedRules.length).to.equal(1);
    expect(savedRules[0]).to.include({ target: REMOTE, zssidsDeviceIPs: LAN_DEVICE });
  });

  it('saves no rule for a blocked inbound connection or a DNS server, as zssids blocks neither server', async () => {
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1004, action: 'blocked', deviceIsClient: false }));
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1010, action: 'blocked', deviceIsClient: true, serverPort: 53 }));
    expect(savedRules.length).to.equal(0);
    expect(alarms.length).to.equal(2);
    expect(alarms[0]['p.local_is_client']).to.equal('0');
    expect(alarms[0]).to.not.have.property('result');
    expect(alarms[1]).to.not.have.property('result');
  });

  it('saves the rule of every blocked server, also when the alarm is rate limited', async () => {
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1011, action: 'blocked', deviceIsClient: true, serverPort: 80 }));
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1011, action: 'blocked', deviceIsClient: true, serverPort: 8080 }));
    expect(alarms.length).to.equal(1);
    expect(savedRules.map(r => r.remotePort)).to.deep.equal(['80', '8080']);
  });

  it('records a new IP of the device on its rule, so undo lifts the entry zssids added for that IP too', async () => {
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1015, action: 'blocked', deviceIsClient: true, serverPort: 83 }));
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1016, action: 'blocked', deviceIsClient: true, serverPort: 83, deviceIP: LAN_DEVICE_NEW_IP }));
    // the same IP again is not recorded twice
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1017, action: 'blocked', deviceIsClient: true, serverPort: 83, deviceIP: LAN_DEVICE_NEW_IP }));
    expect(savedRules.length).to.equal(1);
    expect(savedRules[0].zssidsDeviceIPs).to.equal(`${LAN_DEVICE},${LAN_DEVICE_NEW_IP}`);
  });

  it('saves one rule when the drop record and the alert of a hit are processed at the same time', async () => {
    await Promise.all([
      suricataDetect.processAlertEvent(eveRecord({ sid: 1012, action: 'blocked', deviceIsClient: true, serverPort: 81, eventType: 'drop' })),
      suricataDetect.processAlertEvent(eveRecord({ sid: 1012, action: 'blocked', deviceIsClient: true, serverPort: 81, eventType: 'alert' }))
    ]);
    expect(savedRules.length).to.equal(1);
    expect(alarms.length).to.equal(1);
    expect(alarms[0].result_policy).to.equal(savedRules[0].pid);
  });


  it('raises one alarm when a hit is written as a drop record and an alert', async () => {
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1005, action: 'blocked', deviceIsClient: true, eventType: 'drop' }));
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1005, action: 'blocked', deviceIsClient: true, eventType: 'alert' }));
    expect(alarms.length).to.equal(1);
    expect(alarms[0]['p.ips.action']).to.equal('blocked');
  });

  it('processes drop records from eve.json, and skips other event types', async () => {
    const realSetTimeout = global.setTimeout;
    const pending = [];
    // the watcher waits 15 seconds before processing a record, the test runs it at once
    global.setTimeout = (callback) => { pending.push(callback); };
    try {
      await suricataDetect.initWatchers();
      onLine(JSON.stringify(eveRecord({ sid: 1006, action: 'blocked', deviceIsClient: true, eventType: 'drop' })));
      onLine(JSON.stringify(Object.assign(eveRecord({ sid: 1007, action: 'allowed', deviceIsClient: true }), { event_type: 'flow' })));
    } finally {
      global.setTimeout = realSetTimeout;
    }
    expect(pending.length).to.equal(1);
    pending[0]();
    // processing awaits the rule save of the blocked hit before the alarm goes out
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(alarms.length).to.equal(1);
    expect(alarms[0]['p.suricata.signatureId']).to.equal(1006);
  });
});
