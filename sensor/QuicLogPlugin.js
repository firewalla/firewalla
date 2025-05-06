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
'use strict';


const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const rclient = require('../util/redis_manager.js').getRedisClient();
const LogReader = require('../util/LogReader.js');
const Constants = require('../net2/Constants.js');
const conntrack = require('../net2/Conntrack.js');
// const exec = require('child-process-promise').exec;
const LRU = require('lru-cache');
const _ = require('lodash');
const AsyncLock = require('../vendor_lib/async-lock');
const sl = require('./SensorLoader.js');
const { Rule } = require('../net2/Iptables.js');


const lock = new AsyncLock();

const LOG_PREFIX = Constants.LOG_PREFIX_QUIC;
const quicLogFile = '/alog/quic.log';

// const iptablesCmdTemplate = _.template("sudo <%= command  %> <%= action %> FW_FORWARD_LOG -p udp --dport 443 -m udp_tls  --log-tls -j LOG --log-level 7");

class QuicLogPlugin extends Sensor {
  constructor(config) {
    super(config);
    this.featureName = Constants.FEATURE_QUIC_LOG;
    this.connCache = [];
    this.lastFlushTime = new Date().getTime();
    this.localCache = LRU({
        max: this.config.localCacheSize,
        ttl: this.config.localCacheTtl * 1000
    });
  }
  hookFeature(featureName) {
    super.hookFeature(featureName);
  }
  async run() {
    this.hookFeature();
  }

  async _setConnEntryWithCache(conn) {
    lock.acquire('LOCK_CONN_CACHE', async () => {
      const currentTime = new Date().getTime();
      if (this.connCache.length >= this.config.combineReqNumber || 
          (this.connCache.length > 0 &&
           currentTime - this.lastFlushTime > this.config.syncInterval * 1000)) {
        // flush cache if more than combineReqNumber entries or syncInterval seconds passed
        await conntrack.setConnEntriesWithExpire(this.connCache);
        this.connCache = [];
        this.lastFlushTime = currentTime;
      } else {
        this.connCache.push(conn);
      }
    });
  }

  async _flushConnEntryCache() {
    lock.acquire('LOCK_CONN_CACHE', async () => {
      const currentTime = new Date().getTime();
      if (this.connCache.length >= 0) {
        await conntrack.setConnEntriesWithExpire(this.connCache);
        this.connCache = [];
        this.lastFlushTime = currentTime;
      }
    });
  }

  async job() {
    super.job();

    this.quicLogReader = new LogReader(quicLogFile);
    this.quicLogReader.on('line', this._processQuicLog.bind(this));
    this.quicLogReader.watch();
  }

  // process quic log line
  // line format: [FW_QUIC]:{"src_addr":"192.168.169.166", "dst_addr":"142.250.189.14", "src_port":60956, "dst_port":443, "protocol":"UDP", "hostname":"calendar.google.com"}
  async _processQuicLog(line) {
    if (_.isEmpty(line)) return;
    // extract content after log prefix
    const content = line.substring(line.indexOf(LOG_PREFIX) + LOG_PREFIX.length);
    if (!content || content.length == 0)
      return;
    const obj = JSON.parse(content);
    if (!obj || typeof obj !== 'object')
        return;
    const {src_addr, src_port, dst_addr, dst_port, protocol, hostname} = obj;
    const connKey = `conn:${protocol && protocol.toLowerCase()}:${src_addr}:${src_port}:${dst_addr}:${dst_port}`;

    if (this.localCache.has(connKey)) {
        return;
    }

    const data = {};
    data[Constants.REDIS_HKEY_CONN_HOST] = hostname;
    data.proto = "quic";
    data.ip = dst_addr;
    if (this.config.runtimeSync) {
      await conntrack.setConnEntries(src_addr, src_port, dst_addr, dst_port, protocol, data, 600);
    } else {
      const connEntry = {
        src: src_addr,
        srcPort: src_port,
        dst: dst_addr,
        dstPort: dst_port,
        proto: protocol,
        data: data
      }
      await this._setConnEntryWithCache(connEntry);
    }
    this.localCache.set(connKey, true);
    
  }

  async globalOn() { // relay on ACLAuditLogPlugin.globalOn
    super.globalOn();

    const rule = new Rule().chn('FW_FORWARD_LOG');
    rule.mdl("udp_tls", '--log-tls');
    rule.pro('udp');
    rule.dport(443);
    rule.jmp('LOG --log-level 7');
    await rule.exec('-A');
    rule.fam(6);
    await rule.exec('-A');
    
  }

  async globalOff() { // relay on ACLAuditLogPlugin.globalOff
    super.globalOff();
    this.localCache.reset();
    await this._flushConnEntryCache();

    const rule = new Rule().chn('FW_FORWARD_LOG');
    rule.mdl("udp_tls", '--log-tls');
    rule.pro('udp');
    rule.dport(443);
    rule.jmp('LOG --log-level 7');
    await rule.exec('-D');
    rule.fam(6);
    await rule.exec('-D');
  }

}

module.exports = QuicLogPlugin;