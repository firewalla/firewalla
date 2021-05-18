/*    Copyright 2021 Firewalla LLC
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

const _ = require('lodash');

const validator = require('validator');

const IntelTool = require('../net2/IntelTool');
const intelTool = new IntelTool();

const rclient = require('../util/redis_manager.js').getRedisClient();
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

const m = require('../extension/metrics/metrics.js');

const flowUtil = require('../net2/FlowUtil');
const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const cc = require('../extension/cloudcache/cloudcache.js');

const zlib = require('zlib');
const fs = require('fs');

const Promise = require('bluebird');
const inflateAsync = Promise.promisify(zlib.inflate);
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const Alarm = require('../alarm/Alarm.js');
const AlarmManager2 = require('../alarm/AlarmManager2.js')
const am2 = new AlarmManager2();
const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool()
const BF_SERVER_MATCH = "bf_server_match"
const IdentityManager = require('../net2/IdentityManager.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();

const sys = require('sys'),
      Buffer = require('buffer').Buffer,
      dgram = require('dgram');

// slices a single byte into bits
// assuming only single bytes
const sliceBits = function(b, off, len) {
    const s = 7 - (off + len - 1);

    b = b >>> s;
    return b & ~(0xff << len);
};

const qnameToDomain = (qname) => {
  let domain= '';
  for(let i=0;i<qname.length;i++) {
    if (qname[i] == 0) {
      //last char chop trailing .
      domain = domain.substring(0, domain.length - 1);
      break;
    }
    
    const tmpBuf = qname.slice(i+1, i+qname[i]+1);
    domain += tmpBuf.toString('binary', 0, tmpBuf.length);
    domain += '.';
    
    i = i + qname[i];
  }
  
  return domain;
};

const defaultExpireTime = 48 * 3600; // expire in two days, by default
const allowKey = "dns_proxy:allow_list"; //unused at this moment
const passthroughKey = "dns_proxy:passthrough_list";
const blockKey = "dns_proxy:block_list";
const featureName = "dns_proxy";
const defaultListenPort = 9963;

class DNSProxyPlugin extends Sensor {
  async run() {
    // invalidate cache keys when starting up
    await rclient.delAsync(allowKey);
    await rclient.delAsync(blockKey);
    await rclient.delAsync(passthroughKey);
    
    this.hookFeature(featureName);
  }

  getHashKeyName(item = {}) {
    if(!item.count || !item.error || !item.prefix) {
      log.error("Invalid item:", item);
      return null;
    }

    const {count, error, prefix} = item;
    
    return `bf:${prefix}:${count}:${error}`;
  }

  getFilePath(item = {}) {
    if(!item.count || !item.error || !item.prefix) {
      log.error("Invalid item:", item);
      return null;
    }

    const {count, error, prefix} = item;
    
    return `${f.getRuntimeInfoFolder()}/${featureName}.${prefix}.bf.data`;
  }

  getDnsmasqConfigFile() {
    return `${dnsmasqConfigFolder}/${featureName}.conf`;
  }
  
  async enableDnsmasqConfig() {
    const data = this.config.data || [];

    let dnsmasqEntry = "mac-address-tag=%FF:FF:FF:FF:FF:FF$dns_proxy\n";
    
    for(const item of data) {
      const fp = this.getFilePath(item);
      if(!fp) {
        continue;
      }

      const entry = `server-bf-high=<${fp},${item.count},${item.error}><${allowKey}><${blockKey}><${passthroughKey}>127.0.0.1#${this.getPort()}$dns_proxy\n`;
      
      dnsmasqEntry += entry;
    }

    await fs.writeFileAsync(this.getDnsmasqConfigFile(), dnsmasqEntry);
    await dnsmasq.scheduleRestartDNSService();
  }

  async disableDnsmasqConfig() {
    await fs.unlinkAsync(this.getDnsmasqConfigFile());
    await dnsmasq.scheduleRestartDNSService();
  }
  
  async globalOn() {
    sclient.subscribe(BF_SERVER_MATCH)
    sclient.on("message", async (channel, message) => {
      
      switch(channel) {
        case BF_SERVER_MATCH:
          let msgObj;
          try {
            msgObj = JSON.parse(message)
          } catch(err) {
            log.error("parse msg failed", err, message)
          }
          if (msgObj && msgObj.mac) {
            const MAC = msgObj.mac.toUpperCase();
            const ip = msgObj.ip4 || msgObj.ip6;
            await this.processRequest(msgObj.domain, ip, MAC);
          }          
          break;
      }
    })

    sem.on("FastDNSPolicyComplete", async (event) => {
      await rclient.saddAsync(passthroughKey, event.domain);
      await rclient.sremAsync(blockKey, event.domain);
    })

    const data = this.config.data || [];
    if(_.isEmpty(data)) {
      return;
    }

    for(const item of data) {
      const hashKeyName = this.getHashKeyName(item);
      if(!hashKeyName) continue;

      try {
        await cc.enableCache(hashKeyName, (data) => {
          this.updateBFData(item, data);
        });
      } catch(err) {
        log.error("Failed to process bf data:", item);        
      }
    }    
    
    await this.enableDnsmasqConfig();
  }

  async updateBFData(item, content) {
    try {
      if(!content || content.length < 10) {
        // likely invalid, return null for protection
        log.error(`Invalid bf data content for ${item && item.prefix}, ignored`);
        return;
      }
      const buf = Buffer.from(content, 'base64');
      const output = await inflateAsync(buf);
      const fp = this.getFilePath(item);
      if(!fp) return;
      
      await fs.writeFileAsync(fp, output);
    } catch(err) {
      log.error("Failed to update bf data, err:", err);
    }
  }

  async globalOff() {
    sclient.unsubscribe(BF_SERVER_MATCH)
    await cc.disableCache(this.getHashKeyName());
    await this.disableDnsmasqConfig();
  }

  getPort() {
    const port = this.config.listenPort || defaultListenPort;
    
    if(!_.isNumber(port)) {
      log.warn("Invalid port", port, ", reverting back to default port.");
      return defaultListenPort;
    }

    return port;

  }

  async checkCache(domain) { // only return if there is exact-match intel in redis
    return intelTool.getDomainIntel(domain);
  }

  async _genSecurityAlarm(ip, mac, dn, item) {
    let macEntry;
    if (mac) macEntry = await hostTool.getMACEntry(mac);
    if (macEntry) {
      ip = macEntry.ipv4 || macEntry.ipv6 || ip;
    } else {
      if (!ip) return;
      let m;
      const identity = IdentityManager.getIdentityByIP(ip);
      if (identity) m = IdentityManager.getGUID(identity);
      if (!m) return;
      mac = m;
    }
    const alarm = new Alarm.IntelAlarm(new Date() / 1000, ip, "major", {
      "p.device.ip": ip,
      "p.dest.name": dn,
      "p.security.reason": item.msg,
      "p.device.mac": mac,
      "p.action.block": true,
      "p.blockby": "fastdns"
    });
    await am2.enrichDeviceInfo(alarm)
    try {
      await am2.checkAndSaveAsync(alarm);
    } catch (err) {
      if (err.code !== 'ERR_DUP_ALARM' && err.code !== 'ERR_BLOCKED_BY_POLICY_ALREADY') {
        throw new Error("fail to gen fastdns block alarm", err);
      }
    }
  }

  async processRequest(qname, ip, mac) {
    const domain = qname;
    log.info("dns request is", domain);
    const begin = new Date() / 1;
    const cache = await this.checkCache(domain);
    if(cache) {
      log.info(`inteldns:${domain} is already cached locally, updating redis cache keys directly...`);
      if (cache.c === "intel") {
        await this._genSecurityAlarm(ip, mac, domain, cache)
      } else {
        await rclient.saddAsync(passthroughKey, domain);
        await rclient.sremAsync(blockKey, domain);
      }
      return; // do need to do anything
    }
    const result = await intelTool.checkIntelFromCloud(undefined, domain); // parameter ip is undefined since it's a dns request only
    await this.updateCache(domain, result, ip, mac);
    const end = new Date() / 1;
    log.info("dns intel result is", result, "took", Math.floor(end - begin), "ms");
  }

  async updateCache(domain, result, ip, mac) {
    if(_.isEmpty(result)) { // empty intel, means the domain is good
      const domains = flowUtil.getSubDomains(domain);
      if(!domains) {
        log.warn("Invalid Domain", domain, "skipped.");
        return;
      }

      // since result is empty, it means all sub domains of this domain are good
      const placeholder = {c: 'x', a: '1'};
      for(const dn of domains) {
        await intelTool.addDomainIntel(dn, placeholder, defaultExpireTime);
      }

      // only the exact dn is added to the passthrough and block list
      // generic domains can't be added, because another sub domain may be malicous
      // example:
      //   domain1.blogspot.com may be good
      //   and domain2.blogspot.com may be malicous
      // when domain1 is checked to be good, we should NOT add blogspot.com to passthrough_list
      await rclient.saddAsync(passthroughKey, domain);
      await rclient.sremAsync(blockKey, domain);

    } else {
      let skipped = false;
      for(const item of result) {
        const dn = item.originIP; // originIP is the domain
        const isDomain = validator.isFQDN(dn);
        if(!isDomain) {
          continue;
        }

        for(const k in item) { // to suppress redis error
          const v = item[k];
          if(_.isBoolean(v) || _.isNumber(v) || _.isString(v)) {
            continue;
          }
          item[k] = JSON.stringify(v);
        }
       
        if (item.c === "intel" && !skipped) {  
          await this._genSecurityAlarm(ip, mac, dn, item)
          skipped = true
        } else {
          await rclient.saddAsync(passthroughKey, dn);
          await rclient.sremAsync(blockKey, dn);
        }
        await intelTool.addDomainIntel(dn, item, item.e || defaultExpireTime);
        
      }
    }
  }

}

module.exports = DNSProxyPlugin;
