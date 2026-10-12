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

'use strict';

const { expect } = require('chai');

const BOX_IP = '192.168.1.1';
const BOX_LL = 'fe80::200:5eff:fe00:5301';
const BOX_V6 = '2001:db8:1::1';
const LAN_DEVICE = '192.168.1.10';
const REMOTE = '203.0.113.5';
// IPv6 address outside every subnet of the box, which isLocalIP reports as remote
const V6_OUTSIDE = '2001:db8:2::10';
// device with a host record at an address outside every subnet of the box
const KNOWN_OUTSIDE = '10.99.0.20';

const localIPs = new Set([BOX_IP, BOX_LL, LAN_DEVICE]);
const names = { [BOX_LL]: 'Test Box', [LAN_DEVICE]: 'Test Laptop' };

let mock;
let cacheSnapshot;
let broNotice;

function setupMocks() {
  mock = require('mock-require');
  cacheSnapshot = new Set(Object.keys(require.cache));

  mock('../net2/logger.js', () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, verbose: () => {} }));
  mock('../net2/SysManager.js', {
    isLocalIP: (ip) => localIPs.has(ip),
    isMyIP: (ip) => ip === BOX_IP,
    isMyIP6: (ip) => ip === BOX_LL || ip === BOX_V6,
  });
  mock('../net2/HostTool.js', class HostTool {
    async getName(ip) { return names[ip] || null; }
  });

  broNotice = mock.reRequire('../extension/bro/BroNotice.js');
}

function restoreMocks() {
  mock.stopAll();
  for (const id of Object.keys(require.cache)) {
    if (!cacheSnapshot.has(id)) {
      delete require.cache[id];
    }
  }
}

// the alarm net2/BroDetect.js processNoticeData hands over: zeek's src becomes the alarm device
// unless src is neither local nor a known device, in which case src and dst are swapped
function noticeToAlarm(notice) {
  let lh = notice.src;
  let dh = notice.dst;
  if (!localIPs.has(lh) && lh !== KNOWN_OUTSIDE) {
    [lh, dh] = [dh, lh];
  }
  return {
    type: 'ALARM_BRO_NOTICE',
    device: lh,
    'p.device.ip': lh,
    'p.dest.ip': dh,
    'p.noticeType': notice.note,
    'p.message': notice.msg,
  };
}

function portScan(src, dst) {
  return {
    ts: 1700000000.1,
    note: 'Scan::Port_Scan',
    msg: `${src} scanned at least 18 unique ports of host ${dst} in 1m6s`,
    sub: localIPs.has(src) ? 'local' : 'remote',
    src,
    dst,
    actions: ['Notice::ACTION_LOG'],
    suppress_for: 3600.0,
  };
}

describe('BroNotice port scan', function () {
  before(setupMocks);
  after(restoreMocks);

  it('names zeek src as the scanner when the alarm is filed under the target', async () => {
    const cases = [
      { scanner: V6_OUTSIDE, target: BOX_LL, message: `${V6_OUTSIDE} was scanning ports of Test Box(${BOX_LL}).` },
      { scanner: REMOTE, target: LAN_DEVICE, message: `${REMOTE} was scanning ports of Test Laptop(${LAN_DEVICE}).` },
    ];
    for (const c of cases) {
      const notice = portScan(c.scanner, c.target);
      const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);

      expect(alarm['p.device.ip']).to.equal(c.target);
      expect(alarm['p.local_is_client']).to.equal('0');
      expect(alarm['p.message']).to.equal(c.message);
    }
  });

  it('names the alarm device as the scanner when zeek src is local', async () => {
    const notice = portScan(LAN_DEVICE, REMOTE);
    const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);

    expect(alarm['p.device.ip']).to.equal(LAN_DEVICE);
    expect(alarm['p.local_is_client']).to.equal('1');
    expect(alarm['p.message']).to.equal(`Test Laptop was scanning ports of ${REMOTE}.`);
  });

  it('drops a notice whose zeek src is the box itself', async () => {
    for (const box of [BOX_IP, BOX_V6]) {
      const notice = portScan(box, REMOTE);
      expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.equal(null);
    }
  });
});

describe('BroNotice inbound auto-block', function () {
  before(setupMocks);
  after(restoreMocks);

  const notices = [
    { note: 'Heartbleed::SSL_Heartbeat_Attack', msg: 'An TLS heartbleed attack was detected!' },
    { note: 'TeamCymruMalwareHashRegistry::Match', msg: 'Malware Hash Registry Detection rate: 50%' },
  ];

  it('treats a known device outside the local subnets as the client and blocks nothing', async () => {
    for (const n of notices) {
      const notice = { ts: 1700000000.1, note: n.note, msg: n.msg, src: KNOWN_OUTSIDE, dst: REMOTE };
      const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);

      expect(alarm['p.device.ip']).to.equal(KNOWN_OUTSIDE);
      expect(alarm['p.local_is_client']).to.equal('1');
      expect(alarm['p.action.block']).to.equal(undefined);
    }
  });

  it('blocks a remote src, which the alarm carries as p.dest.ip', async () => {
    for (const n of notices) {
      const notice = { ts: 1700000000.1, note: n.note, msg: n.msg, src: REMOTE, dst: LAN_DEVICE };
      const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);

      expect(alarm['p.dest.ip']).to.equal(REMOTE);
      expect(alarm['p.local_is_client']).to.equal('0');
      expect(alarm['p.action.block']).to.equal(true);
    }
  });
});
