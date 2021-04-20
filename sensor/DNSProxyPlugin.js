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

const flowUtil = require('../net2/FlowUtil');

const sys = require('sys'),
      Buffer = require('buffer').Buffer,
      dgram = require('dgram');

// slices a single byte into bits
// assuming only single bytes
const sliceBits = function(b, off, len) {
    var s = 7 - (off + len - 1);

    b = b >>> s;
    return b & ~(0xff << len);
};

const qnameToDomain = (qname) => {    
  var domain= '';
  for(var i=0;i<qname.length;i++) {
    if (qname[i] == 0) {
      //last char chop trailing .
      domain = domain.substring(0, domain.length - 1);
      break;
    }
    
    var tmpBuf = qname.slice(i+1, i+qname[i]+1);
    domain += tmpBuf.toString('binary', 0, tmpBuf.length);
    domain += '.';
    
    i = i + qname[i];
  }
  
  return domain;
}

const expireTime = 48 * 3600; // expire in two days, by default
const allowKey = "fastdns:allow_list";
const blockKey = "fastdns:block_list";
const defaultListenPort = 9963;

class DNSProxyPlugin extends Sensor {
  async run() {
    this.hookFeature("dns_proxy");
    this.launchServer();
  }

  async globalOn() {
    this.launchServer();
  }

  async globalOff() {
    if(this.server) {
      this.server.close();
      this.server = null;
    }
  }

  launchServer() {
    this.server = dgram.createSocket('udp4');

    this.server.on('message', async (msg, info) => {
      const qname = this.parseRequest(msg);
      if(qname) {
        await this.processRequest(qname);        
      }
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
      for(const dn of domains) {
        await intelTool.addDomainIntel(dn, {c: 'x', a: '1'}, expireTime);
      }

      // only last dn be added to allow key for better performance
      if(domains.length > 0) {
        const dn = domains[domains.length - 1];
        await rclient.saddAsync(allowKey, dn);
      }

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
        } else {
          item.a = '1';
          await rclient.saddAsync(allowKey, dn);
        }
      }
    }
  }
}

module.exports = DNSProxyPlugin;
