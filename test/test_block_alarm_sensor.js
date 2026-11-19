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

'use strict'

const chai = require('chai');
const expect = chai.expect;

const AlarmManager2 = require('../alarm/AlarmManager2.js');
const Alarm = require('../alarm/Alarm.js');
const Exception = require('../alarm/Exception.js');
const Constants = require('../net2/Constants.js');
const HostTool = require('../net2/HostTool.js');
const IdentityManager = require('../net2/IdentityManager.js');
const IntelTool = require('../net2/IntelTool.js');
const fc = require('../net2/config.js');
const sysManager = require('../net2/SysManager.js');
const BlockAlarmSensor = require('../sensor/BlockAlarmSensor.js');

const am2 = new AlarmManager2();
const MAC = 'AA:BB:CC:DD:EE:01';
const NRD = { and: [{ field: 'bType', value: 'category' }, { field: 'bTarget', value: 'nrd' }] };
const LOOKALIKE = { and: [{ field: 'bType', value: 'category' }, { field: 'bTarget', value: 'lookalike_domain' }] };
const NRD_TYPE = 'ALARM_CATEGORY_NRD';
const LOOKALIKE_TYPE = 'ALARM_CATEGORY_LOOKALIKE_DOMAIN';
const SETTINGS = [{ key: 'nrd', filter: NRD, alarmType: NRD_TYPE }, { key: 'lookalike_domain', filter: LOOKALIKE, alarmType: LOOKALIKE_TYPE }];

const flush = () => new Promise(resolve => setImmediate(resolve));

function blockEvent(overrides) {
  return Object.assign({ device: MAC, dest: 'new.example.org', bType: 'category', bTarget: 'nrd', pid: 12, fd: 'in', ct: 1, _ts: Date.now() / 1000 }, overrides);
}

describe('test block alarm sensor', function () {
  this.timeout(10000);

  const origs = {};
  let enqueued, saved, now, cyberSecurity, searchDomains, localDomains;
  const realNow = Date.now;
  const realLocalOrSearchDomain = sysManager.isLocalOrSearchDomain;

  before(() => {
    for (const name of ['getDeviceAlarmFields', 'enrichDeviceInfo', 'enqueueAlarm', 'isCyberSecurityEnabled'])
      origs[name] = AlarmManager2.prototype[name];
  });

  beforeEach(() => {
    enqueued = [];
    saved = true;
    cyberSecurity = true;
    searchDomains = [];
    localDomains = [];
    sysManager.isLocalOrSearchDomain = d =>
      searchDomains.some(sd => d.endsWith(`.${sd}`)) || localDomains.some(ld => d.endsWith(`.${ld}`));
    now = realNow();
    Date.now = () => now;
    AlarmManager2.prototype.getDeviceAlarmFields = async ({ mac }) =>
      mac === 'UNKNOWN' ? null : { 'p.device.ip': '192.168.1.10', 'p.device.mac': mac };
    AlarmManager2.prototype.enrichDeviceInfo = async alarm => { alarm['p.device.name'] = 'sim1'; alarm['p.device.id'] = alarm['p.device.mac']; };
    AlarmManager2.prototype.enqueueAlarm = async alarm => { enqueued.push(alarm); return saved; };
    AlarmManager2.prototype.isCyberSecurityEnabled = () => cyberSecurity;
  });

  afterEach(() => {
    Date.now = realNow;
    sysManager.isLocalOrSearchDomain = realLocalOrSearchDomain;
    for (const name of Object.keys(origs)) AlarmManager2.prototype[name] = origs[name];
  });

  const newSensor = (settings = SETTINGS) => new BlockAlarmSensor({ blockAlarmSettings: settings });
  const feed = async (sensor, event) => { sensor._onBlockFlow(event); await flush(); };

  describe('config', () => {
    it('is off by default', async () => {
      const sensor = new BlockAlarmSensor(require('../net2/config.json').sensors.BlockAlarmSensor);
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(0);
    });

    it('keeps the local settings for an empty or missing cloud list', () => {
      const sensor = newSensor();
      sensor.applyConfig({ blockAlarmSettings: [] });
      expect(sensor.settings).to.have.length(2);
      sensor.applyConfig({});
      expect(sensor.settings).to.have.length(2);
      sensor.applyConfig(null);
      expect(sensor.settings).to.have.length(2);
    });

    it('replaces the local settings with a non-empty cloud list', async () => {
      const sensor = newSensor();
      sensor.applyConfig({ blockAlarmSettings: [{ key: 'nrd', filter: NRD, alarmType: NRD_TYPE }] });
      await feed(sensor, blockEvent({ bTarget: 'lookalike_domain' }));
      expect(enqueued).to.have.length(0);
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(1);
    });

    it('turns on from an empty local default', async () => {
      const sensor = newSensor([]);
      sensor.applyConfig({ blockAlarmSettings: SETTINGS });
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(1);
    });

    it('drops only the settings with a malformed filter tree', async () => {
      const bad = [{ and: ['x'] }, { or: [] }, { and: [{ field: 'bType', value: 'category' }, null] }, { or: [{ and: [1] }] }];
      const sensor = newSensor([...bad.map((filter, i) => ({ key: `bad${i}`, filter, alarmType: NRD_TYPE })), { key: 'nrd', filter: NRD, alarmType: NRD_TYPE }]);
      expect(sensor.settings).to.have.length(1);
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(1);
    });

    it('drops a leaf that would match every block', async () => {
      const bad = [{ field: null }, { field: 'bTarget' }, { field: '', value: 'x' }, { field: 5, value: 'x' },
        { and: [{ field: 'bType', value: 'category' }, { field: 'bTargte' }] }];
      const sensor = newSensor(bad.map((filter, i) => ({ key: `bad${i}`, filter, alarmType: NRD_TYPE })));
      expect(sensor.settings).to.have.length(0);
      await feed(sensor, blockEvent({ bTarget: 'porn' }));
      expect(enqueued).to.have.length(0);
    });

    it('drops settings without a filter object', () => {
      const sensor = newSensor([]);
      sensor.applyConfig({ blockAlarmSettings: [null, 'nrd', { key: 'a' }, { key: 'b', filter: 'nrd' }, { key: 'c', filter: {} }, { key: 'nrd', filter: NRD, alarmType: NRD_TYPE }] });
      expect(sensor.settings).to.have.length(1);
    });

    it('drops settings without a known alarm type', async () => {
      const sensor = newSensor([]);
      sensor.applyConfig({ blockAlarmSettings: [
        { key: 'nrd', filter: NRD },
        { key: 'nrd', filter: NRD, alarmType: 'ALARM_CATEGORY' },
        { key: 'nrd', filter: NRD, alarmType: 'ALARM_INTEL' },
        { key: 'nrd', filter: NRD, alarmType: ['ALARM_CATEGORY_NRD'] },
        { key: 'lookalike_domain', filter: LOOKALIKE, alarmType: LOOKALIKE_TYPE }
      ] });
      expect(sensor.settings).to.have.length(1);
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(0);
      await feed(sensor, blockEvent({ bTarget: 'lookalike_domain' }));
      expect(enqueued).to.have.length(1);
    });
  });

  describe('events', () => {
    it('asks for the network of the device and keeps it on the alarm', async () => {
      let asked;
      AlarmManager2.prototype.getDeviceAlarmFields = async args => { asked = args; return { 'p.device.ip': '192.168.1.10', 'p.device.mac': args.mac, 'p.intf.id': 'lan-uuid' }; };
      await feed(newSensor(), blockEvent());
      expect(asked).to.eql({ mac: MAC, withIntf: true });
      expect(enqueued).to.have.length(1);
      expect(enqueued[0]['p.intf.id']).to.equal('lan-uuid');
    });

    it('raises one alarm with the category payload', async () => {
      const sensor = newSensor();
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(1);
      const alarm = enqueued[0];
      expect(alarm).to.be.instanceof(Alarm.CategoryAlarm);
      expect(alarm.type).to.equal(NRD_TYPE);
      expect(alarm['p.device.ip']).to.equal('192.168.1.10');
      expect(alarm['p.device.mac']).to.equal(MAC);
      expect(alarm['p.dest.name']).to.equal('new.example.org');
      expect(alarm['p.dest.category']).to.equal('nrd');
      expect(alarm['p.result']).to.equal('block');
      expect(alarm.result).to.be.undefined; // the handling result stays empty until the user acts
      expect(alarm['p.pid']).to.equal(12);
      expect(alarm['p.local_is_client']).to.equal('1');
      expect(alarm['p.cooldown']).to.equal(86400);
    });

    it('leaves p.pid out when the event has no policy', async () => {
      await feed(newSensor(), blockEvent({ pid: undefined }));
      expect(enqueued).to.have.length(1);
      expect(enqueued[0]).to.not.have.property('p.pid');
    });

    it('marks an inbound block', async () => {
      await feed(newSensor(), blockEvent({ fd: 'out' }));
      expect(enqueued[0]['p.local_is_client']).to.equal('0');
    });

    it('never sets a key that auto-blocks', async () => {
      await feed(newSensor(), blockEvent());
      const alarm = enqueued[0];
      expect(alarm).to.not.have.property('p.action.block');
      expect(alarm).to.not.have.property('p.cloud.decision');
      expect(alarm.needCloudArbitration()).to.be.false;
    });

    it('alarms once per device, domain and category', async () => {
      const sensor = newSensor();
      await feed(sensor, blockEvent());
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(1);
      await feed(sensor, blockEvent({ bTarget: 'lookalike_domain' }));
      await feed(sensor, blockEvent({ dest: 'other.example.org' }));
      await feed(sensor, blockEvent({ device: 'AA:BB:CC:DD:EE:02' }));
      expect(enqueued).to.have.length(4);
    });

    it('raises the alarm type of the setting that matches', async () => {
      const sensor = newSensor();
      await feed(sensor, blockEvent());
      await feed(sensor, blockEvent({ bTarget: 'lookalike_domain' }));
      expect(enqueued.map(a => a.type)).to.eql([NRD_TYPE, LOOKALIKE_TYPE]);
    });

    it('takes the type of the first setting that matches', async () => {
      const sensor = newSensor([{ key: 'a', filter: NRD, alarmType: LOOKALIKE_TYPE }, { key: 'b', filter: NRD, alarmType: NRD_TYPE }]);
      await feed(sensor, blockEvent());
      expect(enqueued.map(a => a.type)).to.eql([LOOKALIKE_TYPE]);
    });

    it('is silent while cyber security is off and resumes when it is on', async () => {
      const sensor = newSensor();
      cyberSecurity = false;
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(0);
      // the muted flow used no cooldown and no cap of the device
      expect(sensor.alarmed.has(`${MAC}|new.example.org|nrd`)).to.be.false;
      expect(sensor.deviceCounts.has(MAC)).to.be.false;
      cyberSecurity = true;
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(1);
    });

    it('skips a domain under a search domain, whose bare name has its own alarm', async () => {
      const sensor = newSensor();
      searchDomains = ['lan.test'];
      await feed(sensor, blockEvent({ dest: 'foo.xn--x.de.lan.test' }));
      expect(enqueued).to.have.length(0);
      expect(sensor.deviceCounts.has(MAC)).to.be.false;
      await feed(sensor, blockEvent({ dest: 'foo.xn--x.de' }));
      expect(enqueued.map(a => a['p.dest.name'])).to.eql(['foo.xn--x.de']);
    });

    it('does not skip a domain outside every search domain', async () => {
      const sensor = newSensor();
      searchDomains = ['lan.test'];
      localDomains = ['lan'];
      await feed(sensor, blockEvent({ dest: 'foo.xn--x.de' }));
      await feed(sensor, blockEvent({ dest: 'foo.xn--x.de.example.org' }));
      expect(enqueued).to.have.length(2);
    });

    it('skips a domain under the local domain suffix', async () => {
      const sensor = newSensor();
      localDomains = ['lan'];
      await feed(sensor, blockEvent({ dest: 'foo.xn--x.de.lan' }));
      expect(enqueued).to.have.length(0);
    });

    it('only checks the suffixes for a flow that a setting selected', async () => {
      const sensor = newSensor();
      let checked = 0;
      sysManager.isLocalOrSearchDomain = () => { checked++; return false; };
      await feed(sensor, blockEvent({ bTarget: 'porn' }));
      expect(checked).to.equal(0);
      await feed(sensor, blockEvent());
      expect(checked).to.equal(1);
    });

    it('does not start a second build for a key that is being built', async () => {
      const sensor = newSensor();
      sensor._onBlockFlow(blockEvent());
      sensor._onBlockFlow(blockEvent());
      await flush();
      expect(enqueued).to.have.length(1);
    });

    it('alarms again after the cooldown', async () => {
      const sensor = newSensor();
      await feed(sensor, blockEvent());
      now += 86400 * 1000 - 1000;
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(1);
      now += 2000;
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(2);
    });

    it('retries on the next event when the job was not saved', async () => {
      const sensor = newSensor();
      saved = false;
      await feed(sensor, blockEvent());
      saved = true;
      await feed(sensor, blockEvent());
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(2);
    });

    it('retries on the next event when the device cannot be resolved', async () => {
      const sensor = newSensor();
      await feed(sensor, blockEvent({ device: 'UNKNOWN' }));
      expect(enqueued).to.have.length(0);
      AlarmManager2.prototype.getDeviceAlarmFields = async ({ mac }) => ({ 'p.device.ip': '192.168.1.10', 'p.device.mac': mac });
      await feed(sensor, blockEvent({ device: 'UNKNOWN' }));
      expect(enqueued).to.have.length(1);
    });

    it('survives a failing build', async () => {
      const sensor = newSensor();
      AlarmManager2.prototype.enrichDeviceInfo = async () => { throw new Error('host not found'); };
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(0);
      expect(sensor.inFlight.size).to.equal(0);
    });

    it('logs the failure of a key at error only once', async () => {
      const sensor = newSensor();
      AlarmManager2.prototype.enrichDeviceInfo = async () => { throw new Error('redis down'); };
      const lines = [];
      const streams = [process.stdout, process.stderr];
      const writes = streams.map(stream => stream.write);
      streams.forEach((stream, i) => {
        stream.write = (chunk, ...args) => {
          if (String(chunk).includes('Failed to raise block alarm')) lines.push(String(chunk));
          return writes[i].call(stream, chunk, ...args);
        };
      });
      try {
        await feed(sensor, blockEvent());
        await feed(sensor, blockEvent());
        await feed(sensor, blockEvent({ dest: 'other.example.org' }));
      } finally {
        streams.forEach((stream, i) => { stream.write = writes[i]; });
      }
      expect(lines).to.have.length(2);
      expect(lines[0]).to.include('new.example.org');
      expect(lines[1]).to.include('other.example.org');
    });

    it('survives an event that breaks the filter', async () => {
      const sensor = newSensor([]);
      sensor.settings = [{ key: 'bad', filter: { and: ['x'] } }];
      await feed(sensor, blockEvent());
      expect(enqueued).to.have.length(0);
    });

    it('skips what is not a domain block of a device', async () => {
      const sensor = newSensor();
      await feed(sensor, blockEvent({ bType: 'country', bTarget: 'nrd' }));
      await feed(sensor, blockEvent({ device: `${Constants.NS_INTERFACE}:0a1b2c3d` }));
      await feed(sensor, blockEvent({ dest: '1.2.3.4' }));
      await feed(sensor, blockEvent({ dest: '2001:db8::1' }));
      await feed(sensor, blockEvent({ bTarget: 'porn' }));
      expect(enqueued).to.have.length(0);
    });

    it('takes at most 10 alarms per device per hour', async () => {
      const sensor = newSensor();
      for (let i = 0; i < 12; i++) await feed(sensor, blockEvent({ dest: `d${i}.example.org` }));
      expect(enqueued).to.have.length(10);
      await feed(sensor, blockEvent({ device: 'AA:BB:CC:DD:EE:02' }));
      expect(enqueued).to.have.length(11);
      now += 3600 * 1000 + 1000;
      await feed(sensor, blockEvent({ dest: 'd11.example.org' }));
      expect(enqueued).to.have.length(12);
    });

    it('caps the builds in flight', async () => {
      const sensor = newSensor();
      const release = [];
      AlarmManager2.prototype.getDeviceAlarmFields = ({ mac }) => new Promise(resolve => release.push(() => resolve({ 'p.device.ip': '192.168.1.10', 'p.device.mac': mac })));
      for (let i = 0; i < 30; i++)
        sensor._onBlockFlow(blockEvent({ device: `AA:BB:CC:DD:EE:${i.toString(16).padStart(2, '0')}` }));
      expect(release).to.have.length(20);
      release.forEach(r => r());
      await flush();
      expect(enqueued).to.have.length(20);
    });
  });

  describe('device fields of an alarm', () => {
    const vpn = { getGUID: () => 'OPENVPN:abc', getIPs: () => ['10.8.0.2'], getNicUUID: () => 'vpn-nic-uuid' };
    const maskedVpn = { getGUID: () => 'OPENVPN:def', getIPs: () => ['10.8.0.3/32'], getNicUUID: () => null };
    const origHost = HostTool.prototype.getMACEntry;
    const origByIP = IdentityManager.getIdentityByIP;
    const origByGUID = IdentityManager.getIdentityByGUID;

    beforeEach(() => {
      AlarmManager2.prototype.getDeviceAlarmFields = origs.getDeviceAlarmFields;
      HostTool.prototype.getMACEntry = async mac => ({
        [MAC]: { ipv4: '192.168.1.10', intf: 'lan-uuid' },
        'AA:BB:CC:DD:EE:02': { ipv4Addr: '192.168.1.11' },
        'AA:BB:CC:DD:EE:03': { ipv6Addr: '["fe80::1", "2001:db8::3"]' }
      })[mac] || null;
      IdentityManager.getIdentityByIP = ip => ip === '10.8.0.2' ? vpn : null;
      IdentityManager.getIdentityByGUID = guid => ({ 'OPENVPN:abc': vpn, 'OPENVPN:def': maskedVpn })[guid] || null;
    });

    afterEach(() => {
      HostTool.prototype.getMACEntry = origHost;
      IdentityManager.getIdentityByIP = origByIP;
      IdentityManager.getIdentityByGUID = origByGUID;
    });

    it('resolves a mac to the ip of its host entry', async () => {
      expect(await am2.getDeviceAlarmFields({ mac: MAC })).to.eql({ 'p.device.ip': '192.168.1.10', 'p.device.mac': MAC });
      expect(await am2.getDeviceAlarmFields({ mac: MAC, ip: '1.1.1.1' })).to.eql({ 'p.device.ip': '192.168.1.10', 'p.device.mac': MAC });
    });

    it('adds the network of a host or an identity only when asked', async () => {
      expect(await am2.getDeviceAlarmFields({ mac: MAC, withIntf: true })).to.eql({ 'p.device.ip': '192.168.1.10', 'p.device.mac': MAC, 'p.intf.id': 'lan-uuid' });
      expect(await am2.getDeviceAlarmFields({ mac: 'AA:BB:CC:DD:EE:02', withIntf: true })).to.eql({ 'p.device.ip': '192.168.1.11', 'p.device.mac': 'AA:BB:CC:DD:EE:02' });
      expect(await am2.getDeviceAlarmFields({ mac: 'OPENVPN:abc', withIntf: true }))
        .to.eql({ 'p.device.ip': '10.8.0.2', 'p.device.mac': 'OPENVPN:abc', 'p.device.guid': 'OPENVPN:abc', 'p.intf.id': 'vpn-nic-uuid' });
      expect(await am2.getDeviceAlarmFields({ mac: 'OPENVPN:def', withIntf: true }))
        .to.eql({ 'p.device.ip': '10.8.0.3', 'p.device.mac': 'OPENVPN:def', 'p.device.guid': 'OPENVPN:def' });
    });

    it('resolves a mac without an ipv4 field to its ipv4Addr or last ipv6 address', async () => {
      expect(await am2.getDeviceAlarmFields({ mac: 'AA:BB:CC:DD:EE:02' })).to.eql({ 'p.device.ip': '192.168.1.11', 'p.device.mac': 'AA:BB:CC:DD:EE:02' });
      expect(await am2.getDeviceAlarmFields({ mac: 'AA:BB:CC:DD:EE:03' })).to.eql({ 'p.device.ip': '2001:db8::3', 'p.device.mac': 'AA:BB:CC:DD:EE:03' });
    });

    it('keeps the given ip over the addresses of an entry without an ipv4 field', async () => {
      expect(await am2.getDeviceAlarmFields({ mac: 'AA:BB:CC:DD:EE:02', ip: 'fd00::5' })).to.eql({ 'p.device.ip': 'fd00::5', 'p.device.mac': 'AA:BB:CC:DD:EE:02' });
      expect(await am2.getDeviceAlarmFields({ mac: 'AA:BB:CC:DD:EE:03', ip: 'fd00::5' })).to.eql({ 'p.device.ip': 'fd00::5', 'p.device.mac': 'AA:BB:CC:DD:EE:03' });
    });

    it('resolves an identity by ip', async () => {
      expect(await am2.getDeviceAlarmFields({ ip: '10.8.0.2', mac: 'AA:BB:CC:DD:EE:99' }))
        .to.eql({ 'p.device.ip': '10.8.0.2', 'p.device.mac': 'OPENVPN:abc', 'p.device.guid': 'OPENVPN:abc' });
    });

    it('resolves an identity by guid, taking its ip', async () => {
      expect(await am2.getDeviceAlarmFields({ mac: 'OPENVPN:abc' }))
        .to.eql({ 'p.device.ip': '10.8.0.2', 'p.device.mac': 'OPENVPN:abc', 'p.device.guid': 'OPENVPN:abc' });
    });

    it('takes the identity ip without its subnet mask', async () => {
      expect(await am2.getDeviceAlarmFields({ mac: 'OPENVPN:def' }))
        .to.eql({ 'p.device.ip': '10.8.0.3', 'p.device.mac': 'OPENVPN:def', 'p.device.guid': 'OPENVPN:def' });
    });

    it('returns null for an unknown device', async () => {
      expect(await am2.getDeviceAlarmFields({ mac: 'AA:BB:CC:DD:EE:99' })).to.be.null;
      expect(await am2.getDeviceAlarmFields({ ip: '172.16.0.1', mac: 'AA:BB:CC:DD:EE:99' })).to.be.null;
    });
  });

  describe('alarm', () => {
    const data = { 'p.device.mac': MAC, 'p.dest.name': 'new.example.org', 'p.dest.category': 'nrd', 'p.device.name': 'sim1', 'p.device.id': MAC };

    const category = (info, type = NRD_TYPE) => new Alarm.CategoryAlarm(type, Date.now() / 1000, '192.168.1.10', info);

    it('dedups on device, domain and category', () => {
      const a = category(data);
      expect(a.isDup(category(data))).to.be.true;
      expect(a.isDup(category(Object.assign({}, data, { 'p.dest.category': 'lookalike_domain' })))).to.be.false;
      expect(a.isDup(category(Object.assign({}, data, { 'p.dest.name': 'other.example.org' })))).to.be.false;
    });

    it('lasts for its cooldown and is not a policy match', () => {
      const a = category(Object.assign({ 'p.cooldown': 86400 }, data));
      expect(a.getExpirationTime()).to.equal(86400);
      expect(a.needPolicyMatch()).to.be.false;
    });

    it('follows the switches of the security alarms, with its own type for the exception', () => {
      for (const type of Alarm.CATEGORY_ALARM_TYPES) {
        const a = category(data, type);
        expect(a.type).to.equal(type);
        expect(a.getNotifPolicyKey()).to.equal('ALARM_INTEL');
        expect(a.isSecurityAlarm()).to.be.true;
        expect(a.getExceptionAlarmType()).to.equal(type);
        // the host security alarm counter keeps its own list
        expect(Alarm.isSecurityAlarm(type)).to.be.false;
      }
    });

    it('is muted by an ALARM_INTEL exception, and not by one of another type', () => {
      const intel = new Exception({ type: 'ALARM_INTEL' });
      const video = new Exception({ type: 'ALARM_VIDEO' });
      for (const type of Alarm.CATEGORY_ALARM_TYPES) {
        const a = category(data, type);
        expect(intel.match(a), type).to.be.true;
        expect(video.match(a), type).to.be.false;
      }
    });

    it('maps both types, and no longer ALARM_CATEGORY, to the category alarm', () => {
      expect(Alarm.CATEGORY_ALARM_TYPES).to.eql([NRD_TYPE, LOOKALIKE_TYPE]);
      for (const type of Alarm.CATEGORY_ALARM_TYPES)
        expect(Alarm.mapping[type]).to.equal(Alarm.CategoryAlarm.prototype);
      expect(Alarm.mapping).to.not.have.property('ALARM_CATEGORY');
    });

    it('is created with its own type from an alias', () => {
      for (const type of Alarm.CATEGORY_ALARM_TYPES) {
        const alarm = am2._genAlarm(Object.assign({ type: Alarm.alarmType2alias(type), device: '192.168.1.10', timestamp: 1700000000 }, data));
        expect(alarm).to.be.instanceof(Alarm.CategoryAlarm);
        expect(alarm.type).to.equal(type);
        expect(alarm.device).to.equal('192.168.1.10');
        expect(alarm.timestamp).to.equal(1700000000);
        expect(alarm['p.dest.name']).to.equal('new.example.org');
      }
    });

    it('renders the message and the push arguments', () => {
      const alarm = am2.jsonToAlarm(Object.assign({ type: NRD_TYPE }, data));
      expect(alarm.message).to.equal('sim1 was blocked from accessing new.example.org');
      expect(alarm.localizedNotificationContentArray()).to.eql(['sim1', 'new.example.org']);
    });

    it('keys the title, content and strings by its own type', () => {
      for (const type of Alarm.CATEGORY_ALARM_TYPES) {
        const alarm = am2.jsonToAlarm(Object.assign({ type }, data));
        expect(alarm.localizedNotificationTitleKey()).to.equal(`notif.title.${type}`);
        expect(alarm.localizedNotificationContentKey()).to.equal(`notif.content.${type}`);
        expect(alarm.getNotifType()).to.equal(`NOTIF_TITLE_${type}`);
        expect(alarm.getNotificationCategory()).to.equal(`NOTIF_${type}`);
        expect(alarm.getInfoCategory()).to.equal(`INFO_${type}`);
      }
    });

    it('has a title, a push text and an info text for each type in en.json', () => {
      const en = require('../locales/en.json');
      for (const type of Alarm.CATEGORY_ALARM_TYPES)
        for (const key of [`NOTIF_TITLE_${type}`, `NOTIF_${type}`, `INFO_${type}`])
          expect(en[key], key).to.be.a('string').that.is.not.empty;
      expect(en).to.not.have.property('NOTIF_TITLE_ALARM_CATEGORY');
    });

    describe('auto block', () => {
      const origUnblockExists = IntelTool.prototype.unblockExists;
      const origIsFeatureOn = fc.isFeatureOn;
      const config = fc.getConfig();
      let origPolicy;

      // the guard is on, so a block key would turn into a global block rule
      before(() => {
        origPolicy = config.policy;
        config.policy = Object.assign({}, origPolicy, { autoBlock: true });
        fc.isFeatureOn = name => name === 'cyber_security.autoBlock' || origIsFeatureOn.call(fc, name);
        IntelTool.prototype.unblockExists = async () => false;
      });

      after(() => {
        config.policy = origPolicy;
        fc.isFeatureOn = origIsFeatureOn;
        IntelTool.prototype.unblockExists = origUnblockExists;
      });

      it('does not auto block a category block alarm', async () => {
        const a = category(Object.assign({ 'p.cooldown': 86400 }, data));
        expect(await am2.shouldAutoBlock(a)).to.be.false;
      });

      it('would auto block the same alarm with a block key', async () => {
        const a = category(Object.assign({ 'p.action.block': true }, data));
        expect(await am2.shouldAutoBlock(a)).to.be.true;
      });
    });

    it('are the only types that skip the cloud arbitration, with ALARM_ACA', () => {
      const skipping = Alarm.CATEGORY_ALARM_TYPES.concat(['ALARM_ACA']);
      for (const [type, proto] of Object.entries(Alarm.mapping))
        expect(proto.needCloudArbitration(), type).to.equal(!skipping.includes(type));
    });
  });
});
