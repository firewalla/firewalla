/*    Copyright 2016-2024 Firewalla Inc.
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

const _ = require('lodash');
const Alarm = require('../alarm/Alarm.js')
const AlarmManager2 = require('../alarm/AlarmManager2.js')
const fc = require('../net2/config.js');
const Constants = require('../net2/Constants.js');
const log = require('../net2/logger.js')(__filename, 'info');
const rclient = require('../util/redis_manager.js').getRedisClient()
const delay = require('../util/util.js').delay;
const LRU = require('lru-cache');

const am2 = new AlarmManager2();

describe.skip('Test alarm event', function(){
  this.timeout(30000);

  before((done) => {
    (
      async() => {
        await fc.syncDynamicFeatures();
        await fc.getConfig(true);
      }
    )();
    done();
  });

  after((done) => {
    done();
  });

  it('should _genAlarm', () => {
    expect(am2._genAlarm({type: 'video', 'p.dest.id': 'dest-1234'})['p.dest.name']).to.be.equal('dest-1234');
    expect(am2._genAlarm({type: 'game', 'p.dest.id': 'dest-2222'})['p.dest.name']).to.be.equal('dest-2222');
    expect(am2._genAlarm({type: 'porn', 'p.dest.id': 'dest-3333'})['p.showMap']).to.be.false;
    expect(am2._genAlarm({type: 'vpn', 'p.dest.id': 'dest-4444'})['p.showMap']).to.be.false;

    expect(am2._genAlarm({type: 'subnet'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'weak_password'}).state).be.equal('init');
    expect(am2._genAlarm({type: 'openport'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'upnp'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'dual_wan'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'screen_time'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'network_monitor_rtt'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'network_monitor_lossrate'}).state).to.be.equal('init');

    expect(am2._genAlarm({type: 'new_device'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'device_back_online'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'device_offline'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'spoofing_device'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'customized'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'customized_security'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'vpn_client_connection'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'vpn_restore'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'vpn_disconnect'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'vulnerability', 'p.vid': 'p.vid.111'})['p.vid']).to.be.equal('p.vid.111');
    expect(am2._genAlarm({type: 'bro_notice', 'p.noticeType': 'alert', 'p.message': 'test'})['p.message']).to.be.equal('test');
    expect(am2._genAlarm({type: 'intel_report'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'intel'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'abnormal_bandwidth_usage'}).state).to.be.equal('init');
    expect(am2._genAlarm({type: 'large_upload', 'p.dest.id': 'dest-3333'})['p.dest.name']).to.be.equal('dest-3333');
    expect(am2._genAlarm({type: 'large_upload_2', 'p.dest.id': 'dest-4444'})['p.dest.name']).to.be.equal('dest-4444');;
    expect(am2._genAlarm({type: 'over_data_plan_usage'}).state).to.be.equal('init');
  });

  it('should apply msp sync', async() => {
    const a = new Alarm.WeakPasswordAlarm(Date.now()/1000, 'eth0.288', {});
    const aid = await am2.saveAlarm(a);
    expect(a.state).to.be.equal('init');

    const alarms = [{aid: aid, state: 'ready', 'r.test':'deleteme', 'e.analytics': {'result': 'something'}, 'non': ''}];
    await am2.mspSyncAlarm('apply', alarms);
    const alarm = await am2.getAlarm(aid);
    const alarmDetail = await am2.getAlarmDetail(aid);
    log.debug('apply alarm', alarm);
    log.debug('apply alarmDetail', alarmDetail);

    expect(Alarm.isSecurityAlarm(alarm.type)).to.be.false;
    expect(alarm.aid).to.be.equal(aid);
    expect(alarm.state).to.be.equal(Constants.ST_ACTIVATED);
    expect(alarm.type).to.be.equal('ALARM_WEAK_PASSWORD');
    expect(alarmDetail['e.analytics']).to.be.equal('{"result":"something"}');

    await am2.removeAlarmAsync(aid);
  });

  it('should _mspSyncAlarm', async () => {
    const a = new Alarm.WeakPasswordAlarm(Date.now()/1000, 'eth0.288', {});
    const aid = await am2.saveAlarm(a);
    let alarm = await am2.getAlarm(aid);
    expect(alarm.state).to.be.equal(Constants.ST_INIT);

    const data = {'apply':[{aid: aid, state: 'ignore'}]};
    await am2._mspSyncAlarm(data);

    alarm = await am2.getAlarm(aid);
    expect(alarm.state).to.be.equal('ignore');
    await am2.removeAlarmAsync(aid);
  });

  it('should get alarm type', () => {
    expect(Alarm.alarmType2alias('ALARM_NEW_DEVICE')).to.be.equal('new_device');
    expect(Alarm.alias2alarmType('video')).to.be.equal('ALARM_VIDEO');
    expect(Alarm.alias2alarmType('large_upload')).to.be.equal('ALARM_LARGE_UPLOAD');
  });
});

describe.skip('Test AlarmManager2', function(){
  this.timeout(30000);

  before((done) => {
    (
      async() => {
        await fc.syncDynamicFeatures();
        this.extdata = await rclient.getAsync("ext.guardian.data");
        await rclient.setAsync("ext.guardian.data", "{\"config\":{\"alarms\":{\"apply\":{\"default\":{\"state\":\"ready\",\"timeout\":1800},\"large_upload\":{\"state\":\"pending\"},\"large_upload_2\":{\"state\":\"pending\"}}}}}");
        log.debug("fc.getConfig", await fc.getConfig(true));
      }
    )();
    done();
  });

  after((done) => {
    (
      async() => {
        await rclient.setAsync("ext.guardian.data", this.extdata);
      }
    )();
    done();
  });

  it('test remove alarm', async() => {
    await am2.removeAlarmAsync("9991");
    await am2.removeAlarmAsync("9992");
    await am2.removeAlarmAsync("9993");
  });

  it('should create alarm', async() => {
    await fc.enableDynamicFeature('msp_sync_alarm');
    expect(am2.isAlarmSyncMspEnabled()).to.be.true;

    const alm0 = am2.jsonToAlarm({type: 'ALARM_WEAK_PASSWORD'});
    expect(alm0.type).to.be.equal('ALARM_WEAK_PASSWORD');
    expect(alm0.state).to.be.undefined;
    am2.applyConfig(alm0);
    expect(alm0.state).to.be.equal(Constants.ST_READY);

    const alm1 = am2.jsonToAlarm({type: 'ALARM_WEAK_PASSWORD', state: 'active'});
    expect(alm1.type).to.be.equal('ALARM_WEAK_PASSWORD');
    expect(alm1.state).to.be.equal(Constants.ST_ACTIVATED);

    const alm2 = new Alarm.NewDeviceAlarm(Date.now()/1000, 'eth0.288', {});
    expect(alm2.type).to.be.equal('ALARM_NEW_DEVICE');
    expect(alm2.state).to.be.equal('init');
    am2.applyConfig(alm2);
    expect(alm2.state).to.be.equal(Constants.ST_READY);

    const alm3 = am2._genAlarm({type: 'video', device: 'eth0.288', 'p.category': 'av'});
    expect(alm3.type).to.be.equal('ALARM_VIDEO');
    expect(alm3.state).to.be.equal('init');
    expect(alm3['p.category']).to.be.equal('av');
    am2.applyConfig(alm3);
    expect(alm3.state).to.be.equal(Constants.ST_READY);
  });

  it('should activate alarm', async() => {
    expect(am2.isAlarmSyncMspEnabled()).to.be.true;

    const alarm = new Alarm.WeakPasswordAlarm(Date.now()/1000, 'eth0.288', {});
    am2.applyConfig(alarm);
    expect(alarm.state).to.be.equal(Constants.ST_READY);
    const aid = await am2.saveAlarm(alarm);

    const attrs = await am2._applyAlarm({aid: aid, state: 'ready'});
    expect(attrs).to.eql({state: 'ready'});

    const alm = await am2.getAlarm(aid);
    await am2.activateAlarm(alm, {origin:{state: 'init'}});
    expect(alm.state).to.be.equal(Constants.ST_ACTIVATED);

    delay(1000);
    const a = await am2.getAlarm(aid);
    expect(a.state).to.be.equal(Constants.ST_ACTIVATED);
    const aaids = await rclient.zrevrangeAsync('alarm_active', '0', '0');
    expect(aaids).to.eql([aid]);

    await am2.removeAlarmAsync(aid);
  });

  it('test _activateAlarm', async () => {
    const alarm = new Alarm.WeakPasswordAlarm(Date.now()/1000, 'eth0.288', {});
    alarm.aid = '8888';
    const result = await am2._activateAlarm(alarm);
    log.debug("_activateAlarm result", result);

    const aaids = await rclient.zrevrangeAsync('alarm_active', '0', '0');
    expect(aaids).to.eql([alarm.aid]);

    await rclient.zrem("alarm_active", parseFloat(alarm.aid));
  });

  it('test clean pending queue', async() => {
    const now = Date.now()/1000;
    const alm1 = new Alarm.WeakPasswordAlarm(now, 'eth0.288', {});
    Object.assign(alm1, {aid: '9991', state: 'init', alarmTimestamp: now-3610});
    const alm2= new Alarm.WeakPasswordAlarm(now, 'eth0.288', {'p.device.ip': '192.168.196.105'});
    Object.assign(alm2, {aid: '9992', state: 'ready', alarmTimestamp: now});
    const alm3 = new Alarm.WeakPasswordAlarm(now, 'eth0.288', {});
    Object.assign(alm3, {aid: '9993', state: 'active', alarmTimestamp: now});
    const opts1 = Object.entries(Object.assign({}, alm1)).flat();
    await rclient.hsetAsync('_alarm:' + alm1.aid, opts1);
    const opts2 = Object.entries(Object.assign({}, alm2)).flat();
    await rclient.hsetAsync('_alarm:' + alm2.aid, opts2);
    const opts3 = Object.entries(Object.assign({}, alm3)).flat();
    await rclient.hsetAsync('_alarm:' + alm3.aid, opts3);

    await rclient.zaddAsync('alarm_pending', alm1.alarmTimestamp, alm1.aid);
    await rclient.zaddAsync('alarm_pending', alm2.alarmTimestamp, alm2.aid);
    await rclient.zaddAsync('alarm_pending', alm3.alarmTimestamp, alm3.aid);

    await am2.cleanPendingQueue();

    delay(2000);
    const aids = await rclient.zrevrangeAsync('alarm_pending', 0, -1);
    const aaids = await rclient.zrevrangeAsync('alarm_active', 0, -1);
    
    log.debug('post clean alarm pending', aids)
    expect(aids).to.be.not.include('9991', '9992', '9993' );
    expect(aaids).to.be.includes('9992');
    
    await am2.removeAlarmAsync("9991");
    await am2.removeAlarmAsync("9992");
    await am2.removeAlarmAsync("9993");
  });

  it('test load pending alarms', async() => {
    log.debug('list pending alarms:', (await am2.loadPendingAlarms()).map(a => a.aid));
  });

  it('should apply alarm config', async() =>{
    const alarm1 = am2.jsonToAlarm({ type: 'ALARM_VULNERABILITY', device: 'Device 1', state: 'init', 'p.vid': 'p.vid'});
    expect(alarm1.type).to.be.equal("ALARM_VULNERABILITY");
    am2.applyConfig(alarm1);
    expect(alarm1.state).to.be.equal('ready');

    const alarm2 = am2.jsonToAlarm({ type: 'ALARM_SUBNET', device: 'Device 1', state: 'init'});
    expect(alarm2.type).to.be.equal("ALARM_SUBNET");
    am2.applyConfig(alarm2);
    expect(alarm2.state).to.be.equal('ready');
  })

  it.skip('should load recent alarms', async() => {
    const results = await am2.loadRecentAlarmsAsync(3600);
    expect(results.length).to.be.equal(3);
  })

  it('should msp ignore pending alarm', async() => {
    const alarm1 = am2._genAlarm({type: 'subnet', device: 'Device 1'})
    am2.applyConfig(alarm1);
    expect(alarm1.state).to.be.equal(Constants.ST_READY);
    const aid = await am2.saveAlarm(alarm1);

    await am2.mspSyncAlarm('apply', [{aid: aid, state: 'ignore'}]);

    const arvaids = await rclient.zrevrangeAsync('alarm_archive', 0, 0);
    expect(arvaids).to.eql([aid]);
    const data = await rclient.hmgetAsync("_alarm:" + aid, 'state', 'alarmTimestamp','applyTimestamp');
    expect(data[0]).to.be.equal('ignore');
    expect(data[1]).to.be.not.null;
    expect(data[2]).to.be.not.null;

    await am2.removeAlarmAsync(aid);
  });

  it('should mute alarm', async() => {
    const alarm1 = am2._genAlarm({"type":"customized_security","device":"Unknown","p.description":"01:2B:40",
      "p.dest.name":"cnn.com","p.device.ip":"192.168.196.105","p.event.ts":1721353562.99956,"p.msp.type":"1"})
    if (!fc.isFeatureOn("cyber_security")) {
      expect (am2.isMuteAlarm(alarm1)).to.be.true;
    } else {
      expect (am2.isMuteAlarm(alarm1)).to.be.false;
    }
  });
});

const alarms = [
  {"ts":1724741980.386,"type":"ALARM_LARGE_UPLOAD","state":"active","aid":153,"archived":1},
  {"ts":1724733199.748,"type":"ALARM_INTEL","state":"active","aid":148},
  {"ts":1724733519.949,"type":"ALARM_GAME","state":"active","aid":152},
  {"ts":1724851917.634,"type":"ALARM_DUAL_WAN","state":"active","aid":155},
  {"ts":1724989202.173,"type":"ALARM_NEW_DEVICE","state":"active","aid":175},
  {"ts":1724989220.209,"type":"ALARM_ABNORMAL_BANDWIDTH_USAGE","state":"ignore","aid":176},
  {"ts":1726291741.772,"type":"ALARM_VPN_RESTORE","state":"active","aid":241},
  {"ts":1726290923.7,"type":"ALARM_VPN_DISCONNECT","state":"active","aid":240},
  {"ts":1724733200.606,"type":"ALARM_INTEL","state":"active","aid":150},
  {"ts":1724733200.231,"type":"ALARM_INTEL","state":"pending","aid":149},
];

describe('Test alarm cache', function(){
  this.timeout(30000);

  before((done) => (
    async() => {
      am2.indexCache.cache.reset();
      done();
    })()
  );

  after((done) => (
    async() => {
      done();
    })()
  );

  it('test cache size', () =>  {
    expect(am2.indexCache._sizeof("1")).to.be.equal(16);
    expect(am2.indexCache._sizeof(2)).to.be.equal(8);
    expect(am2.indexCache._sizeof(true)).to.be.equal(4);
    expect(am2.indexCache._objsize([1,"1",true])).to.be.equal(28);
    expect(am2.indexCache._objsize({"aid":"15221","state":"ignore","archived":1,"ts":1724733119.223})).to.be.equal(128);
  });

  it('test set cache', async() => {
    for (const a of alarms) {
      await am2.indexCache.add(a);
    }
    expect(am2.indexCache.keys().sort()).to.be.eql(["ALARM_ABNORMAL_BANDWIDTH_USAGE", "ALARM_DUAL_WAN", "ALARM_GAME", "ALARM_INTEL", "ALARM_LARGE_UPLOAD", "ALARM_NEW_DEVICE", "ALARM_VPN_DISCONNECT", "ALARM_VPN_RESTORE"]);
    expect(am2.indexCache.list().sort()).to.be.eql(["148", "149", "150", "152", "153", "155", "175", "176", "240", "241"]);
    expect(am2.indexCache.size()).to.be.equal(1152);
  });

  it('test query cached alarm ids', async() => {
    let ids;
    ids = am2._queryCachedAlarmIds(6, Date.now()/1000, false, 'active', {types: ["ALARM_INTEL", "ALARM_LARGE_UPLOAD", "ALARM_VPN_DISCONNECT", "ALARM_GAME"]});
    expect(ids).to.be.eql([240, 152, 150, 148]);

    ids = am2._queryCachedAlarmIds(3, 1724733119, true, 'active', {types: ["ALARM_INTEL", "ALARM_LARGE_UPLOAD", "ALARM_VPN_DISCONNECT", "ALARM_GAME"]});
    expect(ids).to.be.eql([148, 150, 152]);

    ids = am2._queryCachedAlarmIds(50, Date.now()/1000, false, 'pending', {types: ["ALARM_INTEL", "ALARM_LARGE_UPLOAD", "ALARM_VPN_DISCONNECT", "ALARM_GAME"]});
    expect(ids).to.be.eql([149]);

    ids = am2._queryCachedAlarmIds(50, Date.now()/1000, false, 'ignore', {types: ["ALARM_INTEL", "ALARM_LARGE_UPLOAD", "ALARM_VPN_DISCONNECT", "ALARM_ABNORMAL_BANDWIDTH_USAGE"]});
    expect(ids).to.be.eql([176]);

    ids = am2._queryCachedAlarmIds(50, Date.now()/1000, false, 'archive', {types: ["ALARM_INTEL", "ALARM_LARGE_UPLOAD", "ALARM_VPN_DISCONNECT", "ALARM_GAME"]});
    expect(ids).to.be.eql([153]);
  });

  it('test delete cache item', async() => {
    expect(am2.indexCache.size()).to.be.equal(1152);
    for (const i of [149, 175]) {
      await am2.indexCache.remove(i);
    }
    expect(am2.indexCache.list().sort()).to.be.eql(["148", "150", "152", "153", "155", "176", "240", "241"]);
    expect(am2.indexCache.size()).to.be.equal(948);
  });

  it('test update alarm cache', async() => {
    await rclient.hsetAsync('_alarm:11111', 'aid', '11111',  'ts', Date.now()/1000, 'type', "ALARM_INTEL", 'state', 'pending');
    await rclient.hsetAsync('_alarm:22222', 'aid', '22222', 'ts', Date.now()/1000, 'type', "ALARM_INTEL", 'state', 'pending');
    await am2._updateAlarmCache({aid: "11111"});
    await am2._updateAlarmCache({aid: "22222"});

    await rclient.unlinkAsync('_alarm:11111');
    await rclient.unlinkAsync('_alarm:22222');
    await am2._deleteAlarmCache({aid: "11111", aids:["22222"]});
  });

  it.skip('test refresh cache', async() => {
    am2.indexCache.add({aid:"11111", type: "ALARM_INTEL", ts: "1724733200.231", state: "active"});
    am2.indexCache.add({aid:"12222", type: "ALARM_INTEL", ts: "1724733200.231", state: "active"});
    am2.indexCache.add({aid:"12333", type: "ALARM_INTEL", ts: "1724733200.231", state: "active"});
    await am2.refreshAlarmCache();
    log.debug(`loaded caches length ${am2.indexCache.length()} items, approximate size ${am2.indexCache.size()} bytes`);
    const alarmIds = await am2.loadAlarmIDs();
    expect(am2.indexCache.length()).to.be.equal(Object.values(alarmIds).flat().length);
  });

  it('test fallback alarm cache', async() => {
    expect(await am2._fallbackAlarmCache()).to.be.true;
    expect(await am2._fallbackAlarmCache("[]")).to.be.true;
    expect(await am2._fallbackAlarmCache([])).to.be.false;
    expect(await am2._fallbackAlarmCache(['test_type'])).to.be.false;
    let result = am2._queryCachedAlarmIds(10, Date.now()/1000, false, 'active', {types: ["test_type"]});
    expect(result).to.be.eql([]);
  });
});
