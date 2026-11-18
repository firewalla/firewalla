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
const REMOTE = '203.0.113.5';

// alarms SuricataDetect handed to the alarm manager
let alarms = [];
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
  mock('../net2/SysManager.js', { isLocalIP: (ip) => ip === LAN_DEVICE });
  mock('../net2/HostManager.js', class HostManager {
    async getIdentityOrHost() {
      return { getReadableName: () => 'Test Laptop', getNicUUID: () => 'intf-1' };
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
    record.src_ip = LAN_DEVICE;
    record.src_port = 51000;
    record.dest_ip = REMOTE;
    record.dest_port = options.serverPort || 80;
    record.direction = 'to_server';
  } else {
    record.src_ip = REMOTE;
    record.src_port = 51000;
    record.dest_ip = LAN_DEVICE;
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
  });

  it('reports an allowed alert as allowed', async () => {
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1001, action: 'allowed', deviceIsClient: true }));
    expect(alarms.length).to.equal(1);
    expect(alarms[0]['p.ips.action']).to.equal('allowed');
    expect(alarms[0]['p.dest.ip']).to.equal(REMOTE);
  });

  it('reports that the engine blocked the connection, without asking for a block rule', async () => {
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1002, action: 'blocked', deviceIsClient: true }));
    expect(alarms.length).to.equal(1);
    expect(alarms[0]['p.ips.action']).to.equal('blocked');
    expect(alarms[0]).to.not.have.property('p.action.block');
    expect(alarms[0]['p.local_is_client']).to.equal('1');
  });

  it('reports a blocked inbound connection the same way', async () => {
    await suricataDetect.processAlertEvent(eveRecord({ sid: 1004, action: 'blocked', deviceIsClient: false }));
    expect(alarms.length).to.equal(1);
    expect(alarms[0]['p.ips.action']).to.equal('blocked');
    expect(alarms[0]).to.not.have.property('p.action.block');
    expect(alarms[0]['p.local_is_client']).to.equal('0');
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
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    expect(alarms.length).to.equal(1);
    expect(alarms[0]['p.suricata.signatureId']).to.equal(1006);
  });
});
