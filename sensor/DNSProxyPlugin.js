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

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;
const systemConfigFile = `${dnsmasqConfigFolder}/clash_system.conf`;

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const sysManager = require('../net2/SysManager.js');

const sys = require('sys'),
      Buffer = require('buffer').Buffer,
      dgram = require('dgram');

class DNSProxyPlugin extends Sensor {
  async run() {
  }

  launchServer() {
    this.server = dgram.createSocket('udp4');

    server.on('message', (msg, info) => {
      let req = this.parseRequest(msg);
      this.processRequest(req);
      // never need to reply back to client as this is not a true dns server
    });
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

  alreadyChecked(domain) {
    
  }
  processRequest(req) {
    log.info("dns request is", req.question.qname);
  }

  updateCache(result) {
    
  }
  
}

module.exports = DNSProxyPlugin;
