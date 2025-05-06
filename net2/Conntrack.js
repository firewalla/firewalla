/*    Copyright 2021-2024 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program. If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require('./logger.js')(__filename);
const features = require('./features.js')
const platform = require('../platform/PlatformLoader.js').getPlatform();
const sem = require('../sensor/SensorEventManager.js').getInstance();
const spawn = require('child_process').spawn;
const exec = require('child-process-promise').exec;

const readline = require('readline');

const LRU = require('lru-cache');
const { Address6 } = require('ip-address');
const f = require('./Firewalla.js');
const Constants = require('./Constants.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const _ = require('lodash');

const FEATURE_NAME = 'conntrack'

class Conntrack {
  constructor() {
    this.config = features.getConfig(FEATURE_NAME)
    if (!this.config.enabled || !platform.isAuditLogSupported()) {
      log.warn(FEATURE_NAME, 'disabled!')
      const stub = {}
      for (const method of Object.getOwnPropertyNames(Conntrack.prototype))
        stub[method] = () => {}
      return stub
    }

    if (!f.isMain())
      return this

    this.scheduledJob = {}
    this.connHooks = {};
    this.connCache = {};
    this.connRemoteDB = new LRU({max: 2048, maxAge: 600 * 1000});

    sem.once('IPTABLES_READY', () => {
      this.parseEstablishedConnections().catch((err) => {
        log.error(`Failed to parse established connections`, err);
      });
    });
  }

  // try to infer wan interface of existing outbound connections using reply dst IP (SNAT-ed source IP) and reply src IP (DNAT-ed dst IP) in conntrack, iptables logs only records new connections after the service is restarted
  // only ipv4 is applicable here because ipv6 does not have NAT
  async parseEstablishedConnections() {
    // wans
    const sysManager = require('./SysManager.js');
    const wanIntfs = sysManager.getWanInterfaces();
    const monitoringIntfs = sysManager.getMonitoringInterfaces();
    for (const wanIntf of wanIntfs) {
      const wanIPs = wanIntf.ip4_addresses || [];
      for (const wanIP of wanIPs) { // in most cases, each wan only has one IPv4 address
        for (const mIntf of monitoringIntfs) {
          const subnets = mIntf.ip4_subnets || [];
          for (const subnet of subnets) { // in most cases, each lan only has one IPv4 subnet
            for (const protocol of ["tcp", "udp"]) {
              const lines = await exec(`sudo conntrack -L -s ${subnet} --reply-dst ${wanIP} -f ipv4 -p ${protocol}`, {maxBuffer: 4 * 1024 * 1024}).then(result => result.stdout.trim().split('\n').filter(Boolean));
              log.info(`Found ${lines.length} IPv4 ${protocol} outbound connections from ${subnet} through ${wanIP} on wan ${wanIntf.name}`);
              for (const line of lines) {
                const conn = this.parseLine(protocol, line);
                conn && await this.setConnEntry(conn.src, conn.sport, conn.dst, conn.dport, protocol, Constants.REDIS_HKEY_CONN_OINTF, wanIntf.uuid, 600);
              }
            }
          }
        }
        for (const protocol of ["tcp", "udp"]) {
          const lines = await exec(`sudo conntrack -L -d ${wanIP} -f ipv4 -p ${protocol}`, {maxBuffer: 4 * 1024 * 1024}).then(result => result.stdout.trim().split('\n').filter(Boolean));
          log.info(`Found ${lines.length} IPv4 ${protocol} inbound connections on wan ${wanIntf.name} ${wanIP}`);
          for (const line of lines) {
            const conn = this.parseLine(protocol, line);
            if (conn && conn.dst !== conn.replysrc) // DNAT-ed IPv4 connection
              await this.setConnEntry(conn.src, conn.sport, conn.replysrc, conn.replysport, protocol, Constants.REDIS_HKEY_CONN_OINTF, wanIntf.uuid, 600);
          }
        }
      }
    }
    // VPN clients
    const VPNClient = require('../extension/vpnclient/VPNClient.js');
    const allProfiles = await VPNClient.getVPNProfilesForInit();
    for (const type of Object.keys(allProfiles)) {
      const profiles = allProfiles[type];
      for (const profile of profiles) {
        const {profileId, localIP, rtId} = profile;
        if (!profileId || !localIP || !rtId)
          continue;
        const rtIdHex = Number(rtId).toString(16);
        for (const mIntf of monitoringIntfs) {
          const subnets = mIntf.ip4_subnets || [];
          for (const subnet of subnets) { // in most cases, each lan only has one IPv4 subnet
            for (const protocol of ["tcp", "udp"]) {
              // use both vpn IP and connmark to match VPN interface in case multiple VPN clients have same IPs
              const lines = await exec(`sudo conntrack -L -s ${subnet} --reply-dst ${localIP} -f ipv4 -p ${protocol} -m 0x${rtIdHex}/0xffff`, {maxBuffer: 4 * 1024 * 1024}).then(result => result.stdout.trim().split('\n').filter(Boolean));
              log.info(`Found ${lines.length} established IPv4 ${protocol} outbound connections from ${subnet} through ${localIP} on ${profile.type} VPN client ${profileId}`);
              for (const line of lines) {
                const conn = this.parseLine(protocol, line);
                conn && await this.setConnEntry(conn.src, conn.sport, conn.dst, conn.dport, protocol, Constants.REDIS_HKEY_CONN_OINTF, `${Constants.ACL_VPN_CLIENT_WAN_PREFIX}${profileId}`, 600);
              }
            }
          }
        }
        for (const protocol of ["tcp", "udp"]) {
          const lines = await exec(`sudo conntrack -L -d ${localIP} -f ipv4 -p ${protocol} -m 0x${rtIdHex}/0xffff`, {maxBuffer: 4 * 1024 * 1024}).then(result => result.stdout.trim().split('\n').filter(Boolean));
          log.info(`Found ${lines.length} IPv4 ${protocol} inbound connections on VPN client ${profileId}`);
          for (const line of lines) {
            const conn = this.parseLine(protocol, line);
            if (conn && conn.dst !== conn.replysrc) // DNAT-ed IPv4 connection
              await this.setConnEntry(conn.src, conn.sport, conn.replysrc, conn.replysport, protocol, Constants.REDIS_HKEY_CONN_OINTF, `${Constants.ACL_VPN_CLIENT_WAN_PREFIX}${profileId}`, 600);
          }
        }
      }
    }
  }

  async spawnProcess(protocol, event = "NEW,DESTROY", src, dst, sport, dport, onNew, onDestroy) {
    const cmdlines = ['conntrack', '-E', '-e', event, '-p', protocol, '-b', '8088608'];
    if (src)
      Array.prototype.push.apply(cmdlines, ['-s', src]);
    if (dst)
      Array.prototype.push.apply(cmdlines, ['-d', dst]);
    if (sport)
      Array.prototype.push.apply(cmdlines, ['--sport', sport]);
    if (dport)
      Array.prototype.push.apply(cmdlines, ['--dport', dport]);
    const conntrackProc = spawn('sudo', cmdlines);
    const reader = readline.createInterface({
      input: conntrackProc.stdout
    });
    conntrackProc.on('exit', (code, signal) => {
      log.info(`conntrack of ${protocol} is terminated and the exit code is ${code}, will be restarted soon`);
      setTimeout(() => {
        this.spawnProcess(protocol, event, src, dst, sport, dport, onNew, onDestroy).catch((err) => {
          log.error(`Failed to spawn conntrack on ${protocol}`, err.message);
        });
      }, 3000);
    })
    reader.on('line', (line) => {
      this.processLine(protocol, line, onNew, onDestroy).catch((err) => {
        log.error(`Failed to process conntrack line: ${line}`, err.message);
      });
    });
  }

  parseLine(protocol, line) {
    const conn = {protocol};
    for (const param of line.split(' ').filter(Boolean)) {
      if (param === "CLOSE" || param === "TIME_WAIT") {
        // connection state
        conn.state = param;
      }
      const kv = param.split('=')
      // the first group of src/dst indicates the connection direction
      if (kv.length != 2 || !kv[0] || !kv[1]) continue

      switch (kv[0]) {
        case 'src':
        case 'dst':
          if (kv[1] === "127.0.0.1" || kv[1] === "::1")
              return;
          if (kv[1].includes(":")) {
            if (kv[1].startsWith("ff:")) // ff00::/8 is IPv6 multicast address range
              return;
            kv[1] = new Address6(kv[1]).correctForm()
          } else {
            const mS8B = kv[1].split(".")[0];
            if (!isNaN(mS8B) && Number(mS8B) >= 224 && Number(mS8B) <= 239) // ipv4 multicast address
              return;
          }
          if (conn[kv[0]])
            conn[`reply${kv[0]}`] = kv[1];
          else
            conn[kv[0]] = kv[1];
          break;
        case 'sport':
        case 'dport':
          if (conn[kv[0]])
            conn[`reply${kv[0]}`] = Number(kv[1]);
          else
            conn[kv[0]] = Number(kv[1]);
          break;
        case 'packets':
          if (conn.hasOwnProperty("origPackets"))
            conn["respPackets"] = Number(kv[1]);
          else
            conn["origPackets"] = Number(kv[1]);
          break;
        case 'bytes':
          if (conn.hasOwnProperty("origBytes"))
            conn["respBytes"] = Number(kv[1]);
          else
            conn["origBytes"] = Number(kv[1]);
          break;
        default:
      }
    }
    return conn;
  }

  async processLine(protocol, line, onNew, onDestroy) {
    if (!this.config.enabled) return    
    try {
      const conn = this.parseLine(protocol, line);
      if (!conn)
        return;
      const event = line.split(' ').filter(Boolean)[0];
      this.setConnRemote(protocol, conn.dst, conn.dport);

      switch (event) {
        case "[NEW]":
          if (onNew)
            onNew(conn);
          break;
        case "[DESTROY]":
          if (onDestroy)
            onDestroy(conn);
          break;
        default:
      }
    } catch (err) {
      log.error(`Failed to process ${protocol} data ${line}`, err.toString())
    }
  }

  getConnStr(connDesc) {
    return `${connDesc.src || "*"}::${connDesc.sport || "*"}::${connDesc.dst || "*"}::${connDesc.dport || "*"}::${connDesc.protocol || "*"}`
  }

  registerConnHook(connDesc, func) {
    const key = this.getConnStr(connDesc);
    if (!this.connHooks[key]) {
      this.spawnProcess(connDesc.protocol || "tcp", "NEW,DESTROY", connDesc.src, connDesc.dst, connDesc.sport, connDesc.dport,
        (connInfo) => {
          this.connCache[this.getConnStr(connInfo)] = { begin: Date.now() / 1000 };
        },
        (connInfo) => {
          const connStr = this.getConnStr(connInfo);
          if (this.connCache[connStr]) {
            connInfo.duration = Date.now() / 1000 - this.connCache[connStr].begin;
            switch (connInfo.state) {
              case "TIME_WAIT":
                if (connInfo.duration > 120)
                  connInfo.duration -= 120; // nf_conntrack_tcp_timeout_time_wait = 120
                break;
              case "CLOSE":
              default:
                if (connInfo.duration > 10)
                  connInfo.duration -= 10; // nf_conntrack_tcp_timeout_close
                break;
            }
            const func = this.connHooks[key];
            // func can be updated over the run
            if (typeof func === 'function')
              func(connInfo);
            delete this.connCache[connStr];
          }
        }
      );
    }
    this.connHooks[key] = func;
  }

  getKey(src, sport, dst, dport, protocol) {
    return `conn:${protocol && protocol.toLowerCase()}:${src}:${sport}:${dst}:${dport}`;
  }

  async setConnEntry(src, sport, dst, dport, protocol, subKey, value, expr = 600) {
    const key = `conn:${protocol && protocol.toLowerCase()}:${src}:${sport}:${dst}:${dport}`;
    await rclient.multi()
      .hset(key, subKey, value)
      .expire(key, expr)
      .execAsync()
  }

  async setConnEntries(src, sport, dst, dport, protocol, obj, expr = 600) {
    const key = `conn:${protocol && protocol.toLowerCase()}:${src}:${sport}:${dst}:${dport}`;
    if (!_.isEmpty(obj)) {
      await rclient.multi()
        .hmset(key, obj)
        .expire(key, expr)
        .execAsync()
    }
  }

  async setConnEntriesWithExpire(entries, expr = 600) {
    if (!_.isEmpty(entries)) {
      const pipeline = rclient.multi();
      entries.forEach(entry => {
        const key = `conn:${entry.protocol && entry.protocol.toLowerCase()}:${entry.src}:${entry.sport}:${entry.dst}:${entry.dport}`;
        pipeline.hset(key, entry.data);
        pipeline.expire(key, expr);
      });
      await pipeline.execAsync();
    }
  }

  async delConnEntries(src, sport, dst, dport, protocol) {
    const key = this.getKey(src, sport, dst, dport, protocol)
    await rclient.unlinkAsync(key)
  }

  async getConnEntry(src, sport, dst, dport, protocol, subKey, expr) {
    const key = `conn:${protocol && protocol.toLowerCase()}:${src}:${sport}:${dst}:${dport}`;
    const result = await rclient.hgetAsync(key, subKey);
    if (result && expr)
      rclient.expireAsync(key, expr).catch(()=>{})
    return result;
  }

  async getConnEntries(src, sport, dst, dport, protocol, expr) {
    const key = `conn:${protocol && protocol.toLowerCase()}:${src}:${sport}:${dst}:${dport}`;
    const result = await rclient.hgetallAsync(key);
    if (result && expr)
      rclient.expireAsync(key, expr).catch(()=>{})
    return result;
  }

  setConnRemote(protocol, ip, port) {
    const key = `${protocol && protocol.toLowerCase()}:${ip}:${port || 0}`;
    this.connRemoteDB.set(key, true);
  }

  getConnRemote(protocol, ip, port) {
    const key = `${protocol && protocol.toLowerCase()}:${ip}:${port || 0}`;
    return this.connRemoteDB.get(key) || false;
  }
}

module.exports = new Conntrack();
