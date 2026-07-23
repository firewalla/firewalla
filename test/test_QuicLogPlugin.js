/*    Copyright 2025-2026 Firewalla Inc.
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

const conntrack = require('../net2/Conntrack.js');
const Constants = require('../net2/Constants.js');

const QuicLogPlugin = require('../sensor/QuicLogPlugin.js');

const DEFAULT_CONFIG = {
  localCacheSize: 100,
  localCacheTtl: 60,
  combineReqNumber: 10,
  syncInterval: 5,
  runtimeSync: false,
};

describe('QuicLogPlugin._processQuicLog', function () {
  this.timeout(3000);

  let plugin;
  let setConnEntriesCalls;
  let setConnEntriesWithExpireCalls;
  let origSetConnEntries;
  let origSetConnEntriesWithExpire;

  beforeEach(() => {
    plugin = new QuicLogPlugin({ ...DEFAULT_CONFIG });

    setConnEntriesCalls = [];
    setConnEntriesWithExpireCalls = [];

    origSetConnEntries = conntrack.setConnEntries;
    origSetConnEntriesWithExpire = conntrack.setConnEntriesWithExpire;

    conntrack.setConnEntries = async (...args) => { setConnEntriesCalls.push(args); };
    conntrack.setConnEntriesWithExpire = async (...args) => { setConnEntriesWithExpireCalls.push(args); };
  });

  afterEach(() => {
    conntrack.setConnEntries = origSetConnEntries;
    conntrack.setConnEntriesWithExpire = origSetConnEntriesWithExpire;
  });

  it('should ignore empty lines', async () => {
    await plugin._processQuicLog('');
    expect(setConnEntriesCalls.length).to.equal(0);
    expect(plugin.connCache.length).to.equal(0);
  });

  it('should ignore lines without the QUIC log prefix', async () => {
    await plugin._processQuicLog('some random log line without prefix');
    expect(setConnEntriesCalls.length).to.equal(0);
    expect(plugin.connCache.length).to.equal(0);
  });

  it('should queue a conn entry for a valid QUIC log line (non-runtimeSync)', async () => {
    const line = '[FW_QUIC]:{"src_addr":"192.168.1.100", "dst_addr":"142.250.189.14", "src_port":60956, "dst_port":443, "protocol":"UDP", "hostname":"calendar.google.com"}';
    await plugin._processQuicLog(line);

    expect(setConnEntriesCalls.length).to.equal(0);
    expect(plugin.connCache.length).to.equal(1);
    const entry = plugin.connCache[0];
    expect(entry.src).to.equal('192.168.1.100');
    expect(entry.srcPort).to.equal(60956);
    expect(entry.dst).to.equal('142.250.189.14');
    expect(entry.dstPort).to.equal(443);
    expect(entry.proto).to.equal('UDP');
    expect(entry.data[Constants.REDIS_HKEY_CONN_HOST]).to.equal('calendar.google.com');
    expect(entry.data.proto).to.equal('quic');
    expect(entry.data.ip).to.equal('142.250.189.14');
  });

  it('should call setConnEntries directly when runtimeSync is true', async () => {
    plugin.config = { ...DEFAULT_CONFIG, runtimeSync: true };
    const line = '[FW_QUIC]:{"src_addr":"10.0.0.1", "dst_addr":"8.8.8.8", "src_port":1234, "dst_port":443, "protocol":"UDP", "hostname":"dns.google"}';
    await plugin._processQuicLog(line);

    expect(setConnEntriesCalls.length).to.equal(1);
    const [src, sport, dst, dport, proto, data] = setConnEntriesCalls[0];
    expect(src).to.equal('10.0.0.1');
    expect(sport).to.equal(1234);
    expect(dst).to.equal('8.8.8.8');
    expect(dport).to.equal(443);
    expect(proto).to.equal('UDP');
    expect(data[Constants.REDIS_HKEY_CONN_HOST]).to.equal('dns.google');
    expect(data.proto).to.equal('quic');
    expect(data.ip).to.equal('8.8.8.8');
  });

  it('should deduplicate the same connection using localCache', async () => {
    const line = '[FW_QUIC]:{"src_addr":"192.168.1.100", "dst_addr":"142.250.189.14", "src_port":60956, "dst_port":443, "protocol":"UDP", "hostname":"calendar.google.com"}';
    await plugin._processQuicLog(line);
    const cacheAfterFirst = plugin.connCache.length;
    await plugin._processQuicLog(line);
    // second call should be a no-op due to localCache hit
    expect(plugin.connCache.length).to.equal(cacheAfterFirst);
  });

  it('should handle syslog-prefixed line with timestamp', async () => {
    const line = 'May 13 10:00:00 router kernel: [FW_QUIC]:{"src_addr":"10.1.2.3", "dst_addr":"93.184.216.34", "src_port":55000, "dst_port":443, "protocol":"UDP", "hostname":"example.com"}';
    await plugin._processQuicLog(line);

    expect(plugin.connCache.length).to.equal(1);
    const entry = plugin.connCache[0];
    expect(entry.src).to.equal('10.1.2.3');
    expect(entry.dst).to.equal('93.184.216.34');
    expect(entry.data[Constants.REDIS_HKEY_CONN_HOST]).to.equal('example.com');
  });

  it('should strip trailing char from "message repeated" lines', async () => {
    // kernel deduplication appends " message repeated N times: [ ... ]"
    // the plugin trims the last char (closing bracket) when detected
    const inner = '{"src_addr":"172.16.0.1", "dst_addr":"1.2.3.4", "src_port":9999, "dst_port":443, "protocol":"UDP", "hostname":"repeated.test"}';
    const line = `2026-05-12T18:48:55.197681+08:00 localhost kernel: message repeated 2 times: [ [FW_QUIC]:${inner}]`;
    await plugin._processQuicLog(line);

    expect(plugin.connCache.length).to.equal(1);
    expect(plugin.connCache[0].src).to.equal('172.16.0.1');
    expect(plugin.connCache[0].dst).to.equal('1.2.3.4');
  });

  it('should not write the same connKey twice (localCache with lowercased protocol)', async () => {
    plugin.config = { ...DEFAULT_CONFIG, runtimeSync: true };
    const line = '[FW_QUIC]:{"src_addr":"10.0.0.2", "dst_addr":"9.9.9.9", "src_port":2000, "dst_port":443, "protocol":"UDP", "hostname":"quad9.net"}';
    await plugin._processQuicLog(line);
    await plugin._processQuicLog(line);
    expect(setConnEntriesCalls.length).to.equal(1);
  });

  it('should treat different src_port as distinct connections', async () => {
    const mkLine = (port) =>
      `[FW_QUIC]:{"src_addr":"192.168.1.1", "dst_addr":"1.1.1.1", "src_port":${port}, "dst_port":443, "protocol":"UDP", "hostname":"one.one.one.one"}`;
    await plugin._processQuicLog(mkLine(1111));
    await plugin._processQuicLog(mkLine(2222));
    expect(plugin.connCache.length).to.equal(2);
  });

  it('should recover the trailing entry from a line with two concatenated kernel messages (missing newline)', async () => {
    // seen in production: a truncated message got glued to the next one without a newline in between
    const line = 'Jul  9 12:32:25 localhost kernel: [6159943.347595] [FW_QUIC]:{"src_addr":"2409:871e:d00:40:4c00:88b1:30dd:ceca", "dst_addr":"240Jul  9 12:34:04 localhost kernel: [6160042.093775] [FW_QUIC]:{"src_addr":"192.168.201.111", "dst_addr":"52.222.244.51", "src_port":59282, "dst_port":443, "protocol":"UDP", "hostname":"www.figma.com"}';
    await plugin._processQuicLog(line);

    expect(plugin.connCache.length).to.equal(1);
    const entry = plugin.connCache[0];
    expect(entry.src).to.equal('192.168.201.111');
    expect(entry.srcPort).to.equal(59282);
    expect(entry.dst).to.equal('52.222.244.51');
    expect(entry.dstPort).to.equal(443);
    expect(entry.proto).to.equal('UDP');
    expect(entry.data[Constants.REDIS_HKEY_CONN_HOST]).to.equal('www.figma.com');
  });
});
