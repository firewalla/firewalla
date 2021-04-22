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

const m = require('../extension/metrics/metrics.js');

const flowUtil = require('../net2/FlowUtil');
const f = require('../../net2/Firewalla.js');

const cc = require('../extension/cloudcache/cloudcache.js');

const zlib = require('zlib');
const fs = require('fs');

const Promise = require('bluebird');
const inflateAsync = Promise.promisify(zlib.inflate);
Promise.promisifyAll(fs);

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

const expireTime = 48 * 3600; // expire in two days, by default
const allowKey = "fastdns:allow_list";
const blockKey = "fastdns:block_list";
const defaultListenPort = 9963;
const bfDataPath = `${f.getRuntimeInfoFolder()}/dnsproxy.bf.data`;

class DNSProxyPlugin extends Sensor {
  async run() {
    this.hookFeature("dns_proxy");
  }

  getHashKeyName() {
    // To be configured
    const count = this.config.bfEntryCount || 1000000;
    const error = this.config.bfErrorRate || 0.0001;
    return `bf:data:${count}:${error}`;
  }
    
  async globalOn() {
    this.launchServer();
    await cc.enableCache(this.getHashKeyName(), (data) => {
      this.updateBFData(data);
    });
  }

  async updateBFData(content) {
    try {
      const buf = Buffer.from(content, 'base64');
      const output = await inflateAsync(buf);
      await fs.writeFileAsync(bfDataPath, output);
    } catch(err) {
      log.error("Failed to update bf data, err:", err);
    }
  }

  async globalOff() {
    if(this.server) {
      this.server.close();
      this.server = null;
    }
    await cc.disableCache(this.getHashKeyName());
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

    let port = this.config.listenPort || defaultListenPort;
    if(!_.isNumber(port)) {
      log.warn("Invalid port", port, ", reverting back to default port.");
      port = defaultListenPort;
    }
    
    this.server.bind(port, '127.0.0.1');
    log.info("DNS proxy server is now running at port:", port);
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

  async processRequest(qname) {
    const domain = qnameToDomain(qname);
    log.info("dns request is", domain);
    const begin = new Date() / 1;
    const cache = await this.checkCache(domain);
    if(cache) {
      log.info("domain info is already cached locally:", cache);
      return; // do need to do anything
    }
    const result = await intelTool.checkIntelFromCloud(undefined, domain); // parameter ip is undefined since it's a dns request only
    await this.updateCache(domain, result);
    const end = new Date() / 1;
    log.info("dns intel result is", result, "took", Math.floor(end - begin), "ms");
  }

  async updateCache(domain, result) {
    if(_.isEmpty(result)) { // empty intel, means the domain is good
      const domains = flowUtil.getSubDomains(domain);
      if(!domains) {
        log.warn("Invalid Domain", domain, "skipped.");
        return;
      }

      // since result is empty, it means all sub domains of this domain are good
      const placeholder = {c: 'x', a: '1'};
      for(const dn of domains) {
        await intelTool.addDomainIntel(dn, placeholder, expireTime);
      }

      // only the exact dn is added to the allow and block list
      // generic domains can't be added, because another sub domain may be malicous
      // example:
      //   domain1.blogspot.com may be good
      //   and domain2.blogspot.com may be malicous
      // when domain1 is checked to be good, we should NOT add blogspot.com to allow_list
      await rclient.saddAsync(allowKey, domain);
      await rclient.sremAsync(blockKey, domain);

    } else {
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
        
        await intelTool.addDomainIntel(dn, item, item.e || expireTime);
        if(item.c === 'intel') { // need to decide the criteria better
          item.a = '0';
          await rclient.saddAsync(blockKey, dn);
          // either allow or block, the same domain can't stay in both set at the same time
          await rclient.sremAsync(allowKey, dn);
        } else {
          item.a = '1';
          await rclient.saddAsync(allowKey, dn);
          await rclient.sremAsync(blockKey, dn);
        }
      }
    }
  }
}

module.exports = DNSProxyPlugin;
