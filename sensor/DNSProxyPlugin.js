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
      // msg example: "{\"mac\":\"%s\",\"bf_path\":\"%s\",\"domain\":\"%s\"}"
      switch(channel) {
        case BF_SERVER_MATCH:
          const msgObj = JSON.parse(message)
          await this.processRequest(msgObj.domain, msgObj.mac);
          break;
      }
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

  launchServer() {
    this.server = dgram.createSocket('udp4');

    this.server.on('message', async (msg, info) => {
      const qname = this.parseRequest(msg);
      if(qname) {
        await this.processRequest(qname);
      }
      await m.incr("dns_proxy_request_cnt");
      // never need to reply back to client as this is not a true dns server
    });

    this.server.on('close', () => {
      log.info("DNS proxy server is closed.");
    });

    const port = this.getPort();
    this.server.bind(port, '127.0.0.1');
    log.info("DNS proxy server is now running at port:", port);
  }

  getPort() {
    const port = this.config.listenPort || defaultListenPort;
    
    if(!_.isNumber(port)) {
      log.warn("Invalid port", port, ", reverting back to default port.");
      return defaultListenPort;
    }

    return port;

  }

  
  parseRequest(req) {
    //see rfc1035 for more details
    //http://tools.ietf.org/html/rfc1035#section-4.1.1
    if(req.length < 16) {
      return null;
    }
    return req.slice(12, req.length - 4);
  }

  async checkCache(domain) { // only return if there is exact-match intel in redis
    return intelTool.getDomainIntel(domain);
  }

  async processRequest(qname, mac) {
    const domain = qname;
    log.info("dns request is", domain);
    const begin = new Date() / 1;
    const cache = await this.checkCache(domain);
    if(cache) {
      log.info(`inteldns:${domain} is already cached locally, updating redis cache keys directly...`);
      await this.updateRedisCacheFromIntel(domain, cache);
      return; // do need to do anything
    }
    const result = await intelTool.checkIntelFromCloud(undefined, domain); // parameter ip is undefined since it's a dns request only
    await this.updateCache(domain, result, mac);
    const end = new Date() / 1;
    log.info("dns intel result is", result, "took", Math.floor(end - begin), "ms");
  }

  async updateCache(domain, result, mac) {
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
      await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), domain);
      await rclient.zremAsync(blockKey, domain);

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
          const deviceips = await hostTool.getIPsByMac(mac.toUpperCase())
          const deviceip = deviceips[0]
          const alarm = new Alarm.IntelAlarm(new Date() / 1000, deviceip, "major", {
            "p.device.ip": deviceip,
            "p.dest.name": dn,
            "p.security.reason": item.msg,
            "p.device.mac": mac,
            "p.blockby": "fastdns"
          });
          await am2.enrichDeviceInfo(alarm)
          am2.enqueueAlarm(alarm);
          skipped = true

          await intelTool.addDomainIntel(dn, item, item.e || defaultExpireTime);
          await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), dn);
          await rclient.zremAsync(blockKey, dn);
        } else {
          await intelTool.addDomainIntel(dn, item, item.e || defaultExpireTime);
          await this.updateRedisCacheFromIntel(dn, item);   
        }
      }
    }
  }

  async updateRedisCacheFromIntel(dn, item) {
    if(item.c === 'intel') { // need to decide the criteria better
      await rclient.zaddAsync(blockKey, Math.floor(new Date() / 1000), dn);
      // either passthrough or block, the same domain can't stay in both set at the same time
      await rclient.zremAsync(passthroughKey, dn);
    } else {
      await rclient.zaddAsync(passthroughKey, Math.floor(new Date() / 1000), dn);
      await rclient.zremAsync(blockKey, dn);
    }    
  }
}

module.exports = DNSProxyPlugin;
