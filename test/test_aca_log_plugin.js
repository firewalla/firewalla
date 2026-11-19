/*    Copyright 2026 Firewalla Inc.
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

const chai = require('chai');
const expect = chai.expect;

const fc = require('../net2/config.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const era = require('../event/EventRequestApi.js');
const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js');
const HostManager = require('../net2/HostManager.js');
const HostTool = require('../net2/HostTool.js');
const AcaLogPlugin = require('../sensor/AcaLogPlugin.js');

const DEFAULT_CONFIG = require('../net2/config.json').sensors.AcaLogPlugin;

const COMPUTER_MAC = 'AA:BB:CC:00:00:01';
const PRINTER_MAC = 'AA:BB:CC:00:00:02';
const CAMERA_MAC = 'AA:BB:CC:00:00:03';
const FIREWALLA_MAC = 'AA:BB:CC:00:00:04';

const DEVICES = {
  [COMPUTER_MAC]: { ip: '192.168.1.10', type: 'laptop', vendor: 'Apple, Inc.' },
  [PRINTER_MAC]: { ip: '192.168.1.11', type: 'printer', vendor: 'HP' },
  [CAMERA_MAC]: { ip: '192.168.1.12', type: 'camera', vendor: 'Hikvision' },
  [FIREWALLA_MAC]: { ip: '192.168.1.13', type: 'router', vendor: 'Firewalla Inc' },
};

function findingLine(mac, fields) {
  const finding = Object.assign({
    ts: 1763371200.5,
    src: DEVICES[mac].ip,
    src_l2_addr: mac.toLowerCase(),
    suppress_for: 3600,
    peer_descr: 'zssids',
  }, fields);
  return JSON.stringify(finding);
}

describe('AcaLogPlugin', function () {
  this.timeout(10000);

  const originals = {};
  let plugin, features, cyberSecurity, recordingOn, enqueueResult;
  let alarms, events, cooldowns, fireApiEvents;

  before(() => {
    originals.isFeatureOn = fc.isFeatureOn;
    originals.setAsync = rclient.setAsync;
    originals.delAsync = rclient.delAsync;
    originals.sendEventToFireApi = sem.sendEventToFireApi;
    originals.addActionEvent = era.addActionEvent;
    originals.getDeviceAlarmFields = AlarmManager2.prototype.getDeviceAlarmFields;
    originals.enqueueAlarm = AlarmManager2.prototype.enqueueAlarm;
    originals.isCyberSecurityEnabled = AlarmManager2.prototype.isCyberSecurityEnabled;
    originals.getIdentityOrHost = HostManager.prototype.getIdentityOrHost;
    originals.isRecordingOn = HostTool.prototype.isRecordingOn;
    originals.getMacEntryByIPRecord = HostTool.prototype.getMacEntryByIPRecord;
  });

  beforeEach(() => {
    plugin = new AcaLogPlugin(DEFAULT_CONFIG);
    features = { aca: true };
    cyberSecurity = true;
    recordingOn = true;
    enqueueResult = true;
    alarms = [];
    events = [];
    cooldowns = new Map();

    fc.isFeatureOn = (name) => features[name] === true;

    // an in-memory SET NX EX and DEL, enough for the cooldown
    rclient.setAsync = async (key, value, nx, ex, seconds) => {
      if (cooldowns.has(key)) {
        return null;
      }
      cooldowns.set(key, seconds);
      return 'OK';
    };
    rclient.delAsync = async (key) => {
      cooldowns.delete(key);
      return 1;
    };

    fireApiEvents = [];
    sem.sendEventToFireApi = (event) => { fireApiEvents.push(event); };
    era.addActionEvent = async (type, value, labels, ts) => {
      events.push({ type, value, labels, ts });
    };

    AlarmManager2.prototype.getDeviceAlarmFields = async ({ ip, mac }) => {
      if (!DEVICES[mac]) {
        return null;
      }
      return { 'p.device.ip': ip, 'p.device.mac': mac, 'p.intf.id': 'intf-1' };
    };
    AlarmManager2.prototype.enqueueAlarm = async (alarm) => {
      alarms.push(alarm);
      return enqueueResult;
    };
    AlarmManager2.prototype.isCyberSecurityEnabled = () => cyberSecurity;

    HostManager.prototype.getIdentityOrHost = async (mac) => {
      const device = DEVICES[mac];
      if (!device) {
        return null;
      }
      return {
        o: { mac: mac, macVendor: device.vendor, detect: { type: device.type } },
        getReadableName: () => `device-${device.type}`,
      };
    };
    HostTool.prototype.isRecordingOn = async () => recordingOn;
    HostTool.prototype.getMacEntryByIPRecord = async (ip) => {
      for (const mac of Object.keys(DEVICES)) {
        if (DEVICES[mac].ip === ip) {
          return { mac: mac, ipv4: ip };
        }
      }
      return null;
    };
  });

  afterEach(() => {
    fc.isFeatureOn = originals.isFeatureOn;
    rclient.setAsync = originals.setAsync;
    rclient.delAsync = originals.delAsync;
    sem.sendEventToFireApi = originals.sendEventToFireApi;
    era.addActionEvent = originals.addActionEvent;
    AlarmManager2.prototype.getDeviceAlarmFields = originals.getDeviceAlarmFields;
    AlarmManager2.prototype.enqueueAlarm = originals.enqueueAlarm;
    AlarmManager2.prototype.isCyberSecurityEnabled = originals.isCyberSecurityEnabled;
    HostManager.prototype.getIdentityOrHost = originals.getIdentityOrHost;
    HostTool.prototype.isRecordingOn = originals.isRecordingOn;
    HostTool.prototype.getMacEntryByIPRecord = originals.getMacEntryByIPRecord;
  });

  describe('default rules', () => {
    it('alarms once on a computer using DoT, then cools down for 30 days', async () => {
      const line = findingLine(COMPUTER_MAC, {
        type: 'dns_bypass', msg: 'DOT to 1.1.1.1 instead of the local resolver',
        dst: '1.1.1.1', dst_p: 853, proto: 'tcp',
        evidence: { method: 'dot', resolvers: ['1.1.1.1'] },
      });

      await plugin.processLine(line);
      await plugin.processLine(line);

      expect(alarms).to.have.length(1);
      const alarm = alarms[0];
      expect(alarm.type).to.equal('ALARM_ACA');
      expect(alarm['p.device.mac']).to.equal(COMPUTER_MAC);
      expect(alarm['p.aca.type']).to.equal('dns_bypass');
      expect(alarm['p.aca.rule']).to.equal('dns_bypass_encrypted');
      expect(alarm['p.aca.message']).to.equal('DOT to 1.1.1.1 instead of the local resolver');
      expect(JSON.parse(alarm['p.aca.evidence'])).to.eql({ method: 'dot', resolvers: ['1.1.1.1'] });
      expect(alarm.requiredKeys().every(key => alarm[key])).to.be.true;
      expect(cooldowns.get(alarm['p.aca.dedup'])).to.equal(2592000);
      expect(events).to.have.length(0);
    });

    it('drops DoH from a downstream Firewalla box', async () => {
      await plugin.processLine(findingLine(FIREWALLA_MAC, {
        type: 'dns_bypass', msg: 'DOH to dns9.quad9.net instead of the local resolver',
        evidence: { method: 'doh', resolvers: ['dns9.quad9.net'] },
      }));

      expect(alarms).to.have.length(0);
      expect(events).to.have.length(0);
    });

    it('drops plain DNS to an outside resolver', async () => {
      await plugin.processLine(findingLine(COMPUTER_MAC, {
        type: 'dns_bypass', msg: 'DNS to 114.114.114.114 instead of the local resolver',
        evidence: { method: 'dns', resolvers: ['114.114.114.114'] },
      }));

      expect(alarms).to.have.length(0);
      expect(events).to.have.length(0);
    });

    it('alarms on outbound SSH from a printer but only logs an event for a computer', async () => {
      const sshFields = {
        type: 'risky_port', msg: 'outbound ssh to 172.182.252.133:22',
        dst: '172.182.252.133', dst_p: 22, proto: 'tcp',
        evidence: { service: 'ssh', conn_state: 'SF', resp_bytes: 5120 },
      };

      await plugin.processLine(findingLine(PRINTER_MAC, sshFields));
      await plugin.processLine(findingLine(COMPUTER_MAC, sshFields));

      expect(alarms).to.have.length(1);
      expect(alarms[0]['p.device.mac']).to.equal(PRINTER_MAC);
      expect(alarms[0]['p.aca.rule']).to.equal('risky_port_unexpected_device');
      expect(events).to.have.length(1);
      expect(events[0].type).to.equal('aca_finding');
      expect(events[0].ts).to.equal(1763371200500);
      // events are only logged, nothing asks FireApi to push them
      expect(fireApiEvents).to.have.length(0);
      expect(events[0].labels).to.include({
        type: 'risky_port', rule: 'risky_port_other', deviceId: COMPUTER_MAC, dst: '172.182.252.133', dstPort: 22,
      });
    });

    it('drops a beacon to a named service but logs one to a bare address', async () => {
      await plugin.processLine(findingLine(COMPUTER_MAC, {
        type: 'beacon', msg: '12 connections to config.extension.grammarly.com:443 every 300s (jitter 1%)',
        dst: '34.1.2.3', dst_p: 443, domain: 'config.extension.grammarly.com',
        evidence: { interval: 300, jitter: 0.01, connections: 12 },
      }));
      await plugin.processLine(findingLine(CAMERA_MAC, {
        type: 'beacon', msg: '12 connections to 113.240.98.22:6101 every 1824s (jitter 0%)',
        dst: '113.240.98.22', dst_p: 6101,
        evidence: { interval: 1824, jitter: 0, connections: 12 },
      }));

      expect(alarms).to.have.length(0);
      expect(events).to.have.length(1);
      expect(events[0].labels).to.include({ type: 'beacon', rule: 'beacon_bare_ip', deviceId: CAMERA_MAC });
    });

    it('alarms on a quick tunnel lookup', async () => {
      await plugin.processLine(findingLine(COMPUTER_MAC, {
        type: 'c2_destination', msg: 'tunnel destination bless-sponsored-struck-dramatic.trycloudflare.com (dns)',
        evidence: { category: 'tunnel', matched: 'trycloudflare.com', seen_in: 'dns' },
      }));

      expect(alarms).to.have.length(1);
      expect(alarms[0]['p.aca.rule']).to.equal('c2_tunnel_or_mining');
    });

    it('alarms on a sweep of one subnet but drops failures spread over the internet', async () => {
      await plugin.processLine(findingLine(COMPUTER_MAC, {
        type: 'fan_out', msg: 'failed connections to 25 destinations in 300s',
        evidence: { trigger: 'failed', destinations: 25, sample: ['10.190.41.20', '10.190.41.77', '10.190.41.3'] },
      }));
      await plugin.processLine(findingLine(PRINTER_MAC, {
        type: 'fan_out', msg: 'failed connections to 25 destinations in 300s',
        evidence: { trigger: 'failed', destinations: 25, sample: ['1.2.3.4', '5.6.7.8', '2001:db8::1'] },
      }));

      expect(alarms).to.have.length(1);
      expect(alarms[0]['p.device.mac']).to.equal(COMPUTER_MAC);
      expect(alarms[0]['p.aca.rule']).to.equal('fan_out_subnet_sweep');
    });

    it('dedups outbound services by port like zssids, not by server', async () => {
      const ssh = (dst) => findingLine(PRINTER_MAC, {
        type: 'risky_port', msg: `outbound ssh to ${dst}:22`, dst: dst, dst_p: 22, proto: 'tcp',
        evidence: { service: 'ssh', conn_state: 'SF', resp_bytes: 3000 },
      });

      await plugin.processLine(ssh('172.182.252.133'));
      await plugin.processLine(ssh('3.138.168.55'));
      await plugin.processLine(findingLine(PRINTER_MAC, {
        type: 'risky_port', msg: 'outbound rdp to 140.82.112.4:3389', dst: '140.82.112.4', dst_p: 3389, proto: 'tcp',
        evidence: { service: 'rdp', conn_state: 'S0', resp_bytes: 0 },
      }));

      expect(alarms).to.have.length(2);
      expect(alarms[0]['p.aca.dedup']).to.equal(`aca:cooldown:risky_port_unexpected_device:${PRINTER_MAC}|22`);
      expect(alarms[1]['p.aca.dedup']).to.equal(`aca:cooldown:risky_port_unexpected_device:${PRINTER_MAC}|3389`);
    });

    it('keeps cooling down a device that changed its IP', async () => {
      const dot = (ip) => JSON.stringify({
        ts: 1763371200.5, type: 'dns_bypass', msg: 'DOT to 1.1.1.1 instead of the local resolver',
        src: ip, src_l2_addr: COMPUTER_MAC.toLowerCase(), evidence: { method: 'dot', resolvers: ['1.1.1.1'] },
      });

      await plugin.processLine(dot('192.168.1.10'));
      await plugin.processLine(dot('192.168.1.20'));

      expect(alarms).to.have.length(1);
    });

    it('dedups every rule that sends something by device first', () => {
      for (const rule of DEFAULT_CONFIG.rules) {
        if (rule.action === 'drop') {
          continue;
        }
        expect(rule.dedupBy, rule.name).to.be.an('array');
        expect(rule.dedupBy[0], rule.name).to.equal('device.id');
      }
    });

    it('drops finding types no rule picks', async () => {
      await plugin.processLine(findingLine(COMPUTER_MAC, {
        type: 'direct_ip', msg: 'connection to 114.80.10.223:443 without a DNS lookup for it',
        dst: '114.80.10.223', dst_p: 443, evidence: { conn_state: 'SF' },
      }));

      expect(alarms).to.have.length(0);
      expect(events).to.have.length(0);
    });
  });

  describe('device of the destination', () => {
    // a rule for brute_force is not in the default config yet, so the tests add one
    function pluginWithBruteForceRule() {
      const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      const dropOthers = config.rules.pop();
      config.rules.push({
        name: 'brute_force_on_service',
        match: { 'finding.type': 'brute_force' },
        action: 'alarm',
        cooldown: 86400,
        dedupBy: ['device.id', 'finding.dst_p'],
      });
      config.rules.push(dropOthers);
      return new AcaLogPlugin(config);
    }

    function bruteForceLine(attacker, frameMac, targetIp) {
      return JSON.stringify({
        ts: 1763371200.5, type: 'brute_force', msg: `21 short connections from ${attacker} to ${targetIp}:22`,
        src: attacker, src_l2_addr: frameMac, dst: targetIp, dst_p: 22, proto: 'tcp',
        evidence: { attempts: 21 },
      });
    }

    it('files brute_force under the attacked device, not the frame source', async () => {
      const bruteForcePlugin = pluginWithBruteForceRule();
      // the frame MAC is a known device here, as with an upstream router in simple mode
      await bruteForcePlugin.processLine(bruteForceLine('5.6.7.8', COMPUTER_MAC.toLowerCase(), DEVICES[PRINTER_MAC].ip));

      expect(alarms).to.have.length(1);
      expect(alarms[0]['p.device.mac']).to.equal(PRINTER_MAC);
      expect(alarms[0]['p.aca.dedup']).to.equal(`aca:cooldown:brute_force_on_service:${PRINTER_MAC}|22`);
    });

    it('counts attacks on one service from many addresses as one', async () => {
      const bruteForcePlugin = pluginWithBruteForceRule();
      await bruteForcePlugin.processLine(bruteForceLine('5.6.7.8', '02:00:00:00:00:01', DEVICES[PRINTER_MAC].ip));
      await bruteForcePlugin.processLine(bruteForceLine('9.9.9.9', '02:00:00:00:00:01', DEVICES[PRINTER_MAC].ip));

      expect(alarms).to.have.length(1);
    });

    it('skips a destination the box does not know', async () => {
      const bruteForcePlugin = pluginWithBruteForceRule();
      await bruteForcePlugin.processLine(bruteForceLine('5.6.7.8', '02:00:00:00:00:01', '192.168.1.99'));

      expect(alarms).to.have.length(0);
    });

    it('drops brute_force while no rule picks it', async () => {
      await plugin.processLine(bruteForceLine('5.6.7.8', '02:00:00:00:00:01', DEVICES[PRINTER_MAC].ip));

      expect(alarms).to.have.length(0);
      expect(events).to.have.length(0);
    });
  });

  describe('gates', () => {
    const tunnelLine = findingLine(COMPUTER_MAC, {
      type: 'c2_destination', msg: 'tunnel destination a.trycloudflare.com (dns)',
      evidence: { category: 'tunnel', matched: 'trycloudflare.com', seen_in: 'dns' },
    });

    it('does nothing while the feature is off', async () => {
      features.aca = false;
      await plugin.processLine(tunnelLine);

      expect(alarms).to.have.length(0);
      expect(cooldowns.size).to.equal(0);
    });

    it('starts no cooldown while cyber security alarms are off', async () => {
      cyberSecurity = false;
      await plugin.processLine(tunnelLine);
      expect(alarms).to.have.length(0);
      expect(cooldowns.size).to.equal(0);

      cyberSecurity = true;
      await plugin.processLine(tunnelLine);
      expect(alarms).to.have.length(1);
    });

    it('skips devices whose monitoring is off', async () => {
      recordingOn = false;
      await plugin.processLine(tunnelLine);

      expect(alarms).to.have.length(0);
    });

    it('skips devices the box does not know', async () => {
      await plugin.processLine(JSON.stringify({
        ts: 1763371200.5, type: 'c2_destination', src: '192.168.1.99', src_l2_addr: '02:00:00:00:00:99',
        msg: 'tunnel destination a.trycloudflare.com (dns)', evidence: { category: 'tunnel' },
      }));

      expect(alarms).to.have.length(0);
    });

    it('clears the cooldown when the alarm could not be queued, so the next finding retries', async () => {
      enqueueResult = false;
      let error = null;
      try {
        await plugin.processLine(tunnelLine);
      } catch (err) {
        error = err;
      }
      expect(error).to.be.an('error');
      expect(cooldowns.size).to.equal(0);

      enqueueResult = true;
      await plugin.processLine(tunnelLine);
      expect(alarms).to.have.length(2);
      expect(cooldowns.size).to.equal(1);
    });

    it('ignores lines that are not findings', async () => {
      await plugin.processLine('');
      await plugin.processLine('not json');
      await plugin.processLine(JSON.stringify({ type: 'beacon' }));
      await plugin.processLine(JSON.stringify({ ts: 'x', type: 'beacon', src: '192.168.1.10' }));

      expect(alarms).to.have.length(0);
      expect(events).to.have.length(0);
    });
  });

  describe('AcaAlarm', () => {
    const payload = {
      'p.device.ip': '192.168.1.11',
      'p.device.mac': PRINTER_MAC,
      'p.device.name': 'office printer',
      'p.aca.type': 'risky_port',
      'p.aca.message': 'outbound ssh to 172.182.252.133:22',
      'p.aca.dedup': 'aca:cooldown:risky_port_unexpected_device:AA:BB:CC:00:00:02|172.182.252.133|22',
    };

    it('renders the device and the finding message', () => {
      const alarm = new Alarm.AcaAlarm(1763371200, '192.168.1.11', payload);
      expect(alarm.localizedMessage()).to.equal('office printer: outbound ssh to 172.182.252.133:22');
      expect(alarm.localizedNotification()).to.equal('office printer: outbound ssh to 172.182.252.133:22');
    });

    it('is a duplicate only of an alarm with the same cooldown key', () => {
      const alarm = new Alarm.AcaAlarm(1763371200, '192.168.1.11', payload);
      const same = new Alarm.AcaAlarm(1763371300, '192.168.1.11', payload);
      const other = new Alarm.AcaAlarm(1763371300, '192.168.1.11', Object.assign({}, payload, { 'p.aca.dedup': 'aca:cooldown:x' }));
      expect(alarm.isDup(same)).to.be.true;
      expect(alarm.isDup(other)).to.be.false;
    });

    it('is rebuilt from its type by the alarm mapping', () => {
      expect(Alarm.mapping.ALARM_ACA).to.equal(Alarm.AcaAlarm.prototype);
      expect(Alarm.alias2alarmType(Alarm.alarmType2alias('ALARM_ACA'))).to.equal('ALARM_ACA');
    });
  });

  describe('findRule', () => {
    const context = {
      finding: { type: 'risky_port', evidence: { service: 'ssh' } },
      device: { type: 'printer' },
    };

    // the rule name says whether that single rule matched
    function matchedRule(rule) {
      const found = new AcaLogPlugin({ rules: [Object.assign({ name: 'only' }, rule)] }).findRule(context);
      if (found) {
        return found.name;
      }
      return null;
    }

    it('matches exact values and values in a list', () => {
      expect(matchedRule({ match: { 'finding.type': 'risky_port', 'device.type': ['tv', 'printer'] } })).to.equal('only');
    });

    it('fails when any condition fails or the field is missing', () => {
      expect(matchedRule({ match: { 'finding.evidence.service': 'rdp' } })).to.be.null;
      expect(matchedRule({ match: { 'device.type': ['tv'] } })).to.be.null;
      expect(matchedRule({ match: { 'finding.type': 'risky_port', 'learned.firstTime': true } })).to.be.null;
    });

    it('matches everything without conditions', () => {
      expect(matchedRule({ match: {} })).to.equal('only');
      expect(matchedRule({})).to.equal('only');
    });

    it('picks the first matching rule', () => {
      const rules = [
        { name: 'rdp', match: { 'finding.evidence.service': 'rdp' } },
        { name: 'printer', match: { 'device.type': 'printer' } },
        { name: 'any', match: {} },
      ];
      expect(new AcaLogPlugin({ rules: rules }).findRule(context).name).to.equal('printer');
    });
  });
});
