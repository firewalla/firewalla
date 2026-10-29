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

// a second LAN device, used as a local TLS server
const LAN_SERVER = '192.168.1.20';

const localIPs = new Set([BOX_IP, BOX_LL, LAN_DEVICE, LAN_SERVER]);
const features = {};
// conntrack host entries keyed as orig_h:orig_p:resp_h:resp_p:proto
const connHosts = {};
const names = { [BOX_LL]: 'Test Box', [LAN_DEVICE]: 'Test Laptop' };
// failed issuer saved on the conn entry of a connection to the server, by server ip; an Error is thrown by the lookup
const failedIssuers = {};
// sha256 of the first failed cert saved on the conn entry, by server ip
const failedFps = {};

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
  mock('../net2/config.js', { isFeatureOn: (name) => features[name] !== false });
  mock('../net2/IntelTool.js', class IntelTool {
    // enough for the plain DNs used here
    parseDN(dn) { return dn ? Object.fromEntries(dn.split(',').map(rdn => rdn.split('='))) : {}; }
  });
  mock('../net2/Conntrack.js', {
    getConnEntries: async (src, sport, dst, dport, proto) => {
      const host = connHosts[`${src}:${sport}:${dst}:${dport}:${proto}`];
      if (host instanceof Error) throw host;
      if (failedIssuers[dst] instanceof Error) throw failedIssuers[dst];
      const entries = {};
      if (host) entries.host = host;
      if (failedIssuers[dst]) Object.assign(entries, {
        validation_status: 'unable to get local issuer certificate',
        cert_chain: JSON.stringify([{ fp: failedFps[dst], subject: { CN: 'leaf' } }, { subject: failedIssuers[dst] }]),
        validation_failed_issuer: JSON.stringify(failedIssuers[dst]),
      });
      if (failedFps[dst]) entries.validation_failed_fp = failedFps[dst];
      return Object.keys(entries).length ? entries : null;
    },
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

describe('BroNotice SSH password guessing', function () {
  before(setupMocks);
  after(restoreMocks);

  function sshScan(src, dst) {
    return {
      ts: 1700000000.1,
      note: 'SSH::Password_Guessing',
      msg: `${src} appears to be guessing SSH passwords (seen in 30 connections).`,
      sub: `Sampled servers:  ${dst}, ${dst}`,
      src,
      actions: ['Notice::ACTION_LOG'],
    };
  }

  it('keeps a local guesser as the device and the sampled server as the dest', async () => {
    const notice = sshScan(LAN_DEVICE, REMOTE);
    const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);

    expect(alarm['p.local_is_client']).to.equal('1');
    expect(alarm['p.device.ip']).to.equal(LAN_DEVICE);
    expect(alarm['p.dest.ip']).to.equal(REMOTE);
  });

  it('files a remote guesser under the sampled local server', async () => {
    const notice = sshScan(REMOTE, LAN_DEVICE);
    const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);

    expect(alarm['p.local_is_client']).to.equal('0');
    expect(alarm['p.device.ip']).to.equal(LAN_DEVICE);
    expect(alarm.device).to.equal(LAN_DEVICE);
    expect(alarm['p.message']).to.equal(`${REMOTE} appears to be guessing SSH passwords (seen in 30 connections) on device: Test Laptop`);
  });
});

describe('BroNotice invalid server certificate', function () {
  before(setupMocks);
  after(restoreMocks);
  afterEach(() => { delete features['cyber_security.invalidServerCert']; });

  // zeek's validate-certs raises the notice with $conn, so src/dst are the tls client/server
  function invalidCert(src, dst, status = 'unable to get local issuer certificate') {
    return {
      ts: 1700000000.1,
      uid: 'C1a2b3',
      'id.orig_h': src,
      'id.orig_p': 52000,
      'id.resp_h': dst,
      'id.resp_p': 443,
      note: 'SSL::Invalid_Server_Cert',
      msg: `SSL certificate validation failed with (${status})`,
      sub: 'CN=*.badssl.com,O=BadSSL,L=San Francisco,ST=California,C=US',
      src,
      dst,
      p: 443,
      actions: ['Notice::ACTION_LOG'],
      suppress_for: 3600.0,
    };
  }

  it('raises an alarm for a local client of a remote server, without auto-block', async () => {
    const notice = invalidCert(LAN_DEVICE, REMOTE);
    const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);

    expect(alarm['p.device.ip']).to.equal(LAN_DEVICE);
    expect(alarm['p.dest.ip']).to.equal(REMOTE);
    expect(alarm['p.local_is_client']).to.equal('1');
    expect(alarm['p.action.block']).to.equal(undefined);
    expect(alarm['p.message']).to.equal(notice.msg);
  });

  it('names the dest with the SNI cached for the connection', async () => {
    const notice = invalidCert(LAN_DEVICE, REMOTE);
    connHosts[`${LAN_DEVICE}:52000:${REMOTE}:443:tcp`] = 'self-signed.badssl.com';
    try {
      const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);
      expect(alarm['p.dest.name']).to.equal('self-signed.badssl.com');
    } finally {
      delete connHosts[`${LAN_DEVICE}:52000:${REMOTE}:443:tcp`];
    }
  });

  it('leaves the dest name unset when no SNI is cached', async () => {
    const notice = invalidCert(LAN_DEVICE, REMOTE);
    const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);
    expect(alarm).to.not.equal(null);
    expect(alarm).to.not.have.property('p.dest.name');
  });

  it('still raises the alarm when the lookup fails', async () => {
    const notice = invalidCert(LAN_DEVICE, REMOTE);
    connHosts[`${LAN_DEVICE}:52000:${REMOTE}:443:tcp`] = new Error('redis down');
    try {
      const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);
      expect(alarm).to.not.equal(null);
      expect(alarm).to.not.have.property('p.dest.name');
    } finally {
      delete connHosts[`${LAN_DEVICE}:52000:${REMOTE}:443:tcp`];
    }
  });

  it('raises nothing when the feature is off', async () => {
    features['cyber_security.invalidServerCert'] = false;
    const notice = invalidCert(LAN_DEVICE, REMOTE);
    expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.equal(null);
  });

  it('raises nothing for a self-signed leaf, in either openssl spelling', async () => {
    for (const status of ['self signed certificate', 'self-signed certificate']) {
      const notice = invalidCert(LAN_DEVICE, REMOTE, status);
      expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.equal(null);
    }
  });

  it('records the validation failure on the alarm as a constant', async () => {
    const expected = {
      'unable to get local issuer certificate': 'cert_invalid_issuer',
      'self signed certificate in certificate chain': 'cert_invalid_issuer',
      'self-signed certificate in certificate chain': 'cert_invalid_issuer',
      'certificate has expired': 'cert_expired',
      'certificate is not yet valid': 'cert_not_yet_valid',
      'certificate signature failure': 'cert_invalid',
    };
    for (const [status, constant] of Object.entries(expected)) {
      const notice = invalidCert(LAN_DEVICE, REMOTE, status);
      const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);
      expect(alarm['p.dest.ssl.validation_status']).to.equal(constant);
    }
  });

  describe('failed issuer', () => {
    afterEach(() => {
      delete failedIssuers[REMOTE];
      delete failedFps[REMOTE];
      broNotice.setIgnoredIssuers(null);
    });

    it('puts the first failed cert issuer, its CN and fingerprint on the alarm', async () => {
      failedIssuers[REMOTE] = { CN: 'emSign ECC Root CA - G3', C: 'IN' };
      failedFps[REMOTE] = 'ba105ce02bac';
      const notice = invalidCert(LAN_DEVICE, REMOTE);
      const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);
      expect(alarm['p.dest.ssl.validation_failed_cert']).to.deep.equal({ issuer: { CN: 'emSign ECC Root CA - G3', C: 'IN' } });
      expect(alarm['p.dest.ssl.validation_failed_cert_issuer_CN']).to.equal('emSign ECC Root CA - G3');
      expect(alarm['p.dest.ssl.validation_failed_fp']).to.equal('ba105ce02bac');
      expect(alarm['p.dest.port']).to.equal(443);
      expect(alarm['e.dest.ssl.validation_status']).to.equal('unable to get local issuer certificate');
      expect(JSON.parse(alarm['e.dest.ssl.cert_chain'])).to.deep.equal([{ fp: 'ba105ce02bac', subject: { CN: 'leaf' } }, { subject: { CN: 'emSign ECC Root CA - G3', C: 'IN' } }]);
    });

    it('drops an issuer of the default list, whatever the attribute order', async () => {
      failedIssuers[REMOTE] = { C: 'US', ST: 'Washington', L: 'Redmond', O: 'Microsoft Corporation', CN: 'Microsoft Root Certificate Authority 2011' };
      const notice = invalidCert(LAN_DEVICE, REMOTE);
      expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.equal(null);
    });

    it('uses the cloud list instead of the default one, and falls back when it is empty', async () => {
      const notice = invalidCert(LAN_DEVICE, REMOTE);
      broNotice.setIgnoredIssuers(['C=US,O=Other Root']);
      failedIssuers[REMOTE] = { O: 'Other Root', C: 'US' };
      expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.equal(null);
      failedIssuers[REMOTE] = { C: 'US', ST: 'Washington', L: 'Redmond', O: 'Microsoft Corporation', CN: 'Microsoft Root Certificate Authority 2011' };
      expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.not.equal(null);
      broNotice.setIgnoredIssuers([]);
      expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.equal(null);
    });

    it('leaves the issuer CN out when the issuer has no CN', async () => {
      failedIssuers[REMOTE] = { C: 'CN', O: 'Some Root' };
      const notice = invalidCert(LAN_DEVICE, REMOTE);
      const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);
      expect(alarm['p.dest.ssl.validation_failed_cert']).to.deep.equal({ issuer: { C: 'CN', O: 'Some Root' } });
      expect(alarm).to.not.have.property('p.dest.ssl.validation_failed_cert_issuer_CN');
    });

    it('still raises the alarm, without the issuer, when none is saved or the lookup fails', async () => {
      for (const saved of [undefined, new Error('redis down')]) {
        failedIssuers[REMOTE] = saved;
        const notice = invalidCert(LAN_DEVICE, REMOTE);
        const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);
        expect(alarm).to.not.equal(null);
        expect(alarm).to.not.have.property('p.dest.ssl.validation_failed_cert');
        expect(alarm).to.not.have.property('p.dest.ssl.validation_failed_fp');
        expect(alarm).to.not.have.property('p.dest.ssl.validation_failed_cert_issuer_CN');
      }
    });
  });

  it('raises nothing when the cert CN is not a domain', async () => {
    for (const sub of ['CN=Mijia Cloud,O=Xiaomi', 'CN=localhost', 'CN=192.168.1.1,O=Router']) {
      const notice = Object.assign(invalidCert(LAN_DEVICE, REMOTE), { sub });
      expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.equal(null);
    }
  });

  it('puts the site subject on the alarm as an object', async () => {
    const notice = Object.assign(invalidCert(LAN_DEVICE, REMOTE), { sub: 'CN=*.badssl.com,O=BadSSL,C=US' });
    const alarm = await broNotice.processNotice(noticeToAlarm(notice), notice);
    expect(alarm['p.dest.ssl.subject']).to.deep.equal({ CN: '*.badssl.com', O: 'BadSSL', C: 'US' });
    const noSub = Object.assign(invalidCert(LAN_DEVICE, REMOTE), { sub: undefined });
    expect(await broNotice.processNotice(noticeToAlarm(noSub), noSub)).to.not.have.property('p.dest.ssl.subject');
  });

  it('keeps a domain or wildcard CN, and a subject without CN', async () => {
    for (const sub of ['CN=*.badssl.com,O=BadSSL', 'CN=dv-g3b-emudhra.we-have-a-problem.com', 'O=No CN Inc', undefined]) {
      const notice = Object.assign(invalidCert(LAN_DEVICE, REMOTE), { sub });
      expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.not.equal(null);
    }
  });

  it('drops a local server, whichever side the client is on', async () => {
    for (const [client, server] of [[LAN_DEVICE, LAN_SERVER], [REMOTE, LAN_SERVER]]) {
      const notice = invalidCert(client, server);
      expect(await broNotice.processNotice(noticeToAlarm(notice), notice)).to.equal(null);
    }
  });
});
