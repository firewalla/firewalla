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
    this.launchServer();
  }

  launchServer() {
    this.server = dgram.createSocket('udp4');

    this.server.on('message', async (msg, info) => {
      let req = this.parseRequest(msg);
      await this.processRequest(req);
      // never need to reply back to client as this is not a true dns server
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
    
    var query = {};
    query.header = {};
    //TODO write code to break questions up into an array
    query.question = {};

    var tmpSlice;
    var tmpByte;
    
    //transaction id
    // 2 bytes
    query.header.id = req.slice(0,2);

    //slice out a byte for the next section to dice into binary.
    tmpSlice = req.slice(2,3);
    //convert the binary buf into a string and then pull the char code
    //for the byte
    tmpByte = tmpSlice.toString('binary', 0, 1).charCodeAt(0);
    
    //qr
    // 1 bit
    query.header.qr = sliceBits(tmpByte, 0,1);
    //opcode
    // 0 = standard, 1 = inverse, 2 = server status, 3-15 reserved
    // 4 bits
    query.header.opcode = sliceBits(tmpByte, 1,4);
    //authorative answer
    // 1 bit
    query.header.aa = sliceBits(tmpByte, 5,1);
    //truncated
    // 1 bit
    query.header.tc = sliceBits(tmpByte, 6,1);
    //recursion desired
    // 1 bit
    query.header.rd = sliceBits(tmpByte, 7,1);

    //slice out a byte to dice into binary
    tmpSlice = req.slice(3,4);
    //convert the binary buf into a string and then pull the char code
    //for the byte
    tmpByte = tmpSlice.toString('binary', 0, 1).charCodeAt(0);
    
    //recursion available
    // 1 bit
    query.header.ra = sliceBits(tmpByte, 0,1);

    //reserved 3 bits
    // rfc says always 0
    query.header.z = sliceBits(tmpByte, 1,3);

    //response code
    // 0 = no error, 1 = format error, 2 = server failure
    // 3 = name error, 4 = not implemented, 5 = refused
    // 6-15 reserved
    // 4 bits
    query.header.rcode = sliceBits(tmpByte, 4,4);

    //question count
    // 2 bytes
    query.header.qdcount = req.slice(4,6);
    //answer count
    // 2 bytes
    query.header.ancount = req.slice(6,8);
    //ns count
    // 2 bytes
    query.header.nscount = req.slice(8,10);
    //addition resources count
    // 2 bytes
    query.header.arcount = req.slice(10, 12);
    
    //assuming one question
    //qname is the sequence of domain labels
    //qname length is not fixed however it is 4
    //octets from the end of the buffer
    query.question.qname = req.slice(12, req.length - 4);
    //qtype
    query.question.qtype = req.slice(req.length - 4, req.length - 2);
    //qclass
    query.question.qclass = req.slice(req.length - 2, req.length);
    
    return query;
  }

  getKey(domain) {
    return `intel:dns:${domain}`;
  }
  
  async checkCache(domain) {
    const domains = flowUtil.getSubDomains(domain);
    if(!domains) {
      log.warn("Invalid Domain", domain, "skipped.");
      return;
    }

    for(const dn of domains) {
      const key = this.getKey(dn);
      const info = await rclient.hgetallAsync(key);
      if(!_.isEmpty(info)) {
        return info;
      }
    }

    return null;
  }

  async processRequest(req) {
    const qname = req.question.qname;
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

      const lastDN = domains[domains.length - 1];
      const key = this.getKey(lastDN);
      await rclient.hmsetAsync(key, {c: 'x', a: '1'});
      await rclient.saddAsync(allowKey, lastDN);
      await rclient.expire(key, expireTime);
    } else {
      for(const item of result) {
        const dn = item.originIP; // originIP is the domain
        const isDomain = validator.isFQDN(dn);
        if(!isDomain) {
          continue;
        }

        const key = this.getKey(dn);
        await rclient.hmsetAsync(key, item);
        if(item.c === 'intel') { // need to decide the criteria better
          item.a = '0';
          await rclient.saddAsync(blockKey, dn);
        } else {
          item.a = '1';
          await rclient.saddAsync(allowKey, dn);
        }
        const expire = item.e || expireTime;
        await rclient.expire(key, expire);
      }
    }
  }
}

module.exports = DNSProxyPlugin;
