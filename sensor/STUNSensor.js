/*    Copyright 2016-2022 Firewalla Inc.
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

const DEFAULT_STUN_SERVERS = [{
    host: "stun.sipgate.net",
    port: 3478
  }, {
    host: "stun.syncthing.net",
    port: 3478
  }
];

const STATE_TEST_1 = "state_test_1";
const STATE_TEST_2 = "state_test_2";
const STATE_TEST_1_2 = "state_test_1_2";
const STATE_TEST_3 = "state_test_3";

const MTYPE_BINDING_REQUEST = 0x0001;
const MTYPE_BINDING_RESPONSE = 0x0101;
const MTYPE_BINDING_ERROR_RESPONSE = 0x0111;

const ATTRTYPE_MAPPED_ADDRESS = 0x0001;
const ATTRTYPE_RESPONSE_ADDRESS = 0x0002;
const ATTRTYPE_CHANGE_REQUEST = 0x0003;
const ATTRTYPE_SOURCE_ADDRESS = 0x0004;
const ATTRTYPE_CHANGED_ADDRESS = 0x0005;

const NAT_TYPE_OPEN = "nat::open";
const NAT_TYPE_FULL_CONE = "nat::full_cone";
const NAT_TYPE_RESTRICTED_CONE = "nat::restricted_cone";
const NAT_TYPE_PORT_RESTRICTED_CONE = "nat::port_restricted_cone";
const NAT_TYPE_SYMMETRIC = "nat::symmetric";
const NAT_TYPE_UNKNOWN = "nat::unknown";

const dgram = require('dgram');
const _ = require('lodash');
const sysManager = require('../net2/SysManager.js');
const extensionManager = require('./ExtensionManager.js');
const {Address4} = require('ip-address');
const exec = require('child-process-promise').exec;
const uuid = require('uuid');

class STUNSensor extends Sensor {

  async apiRun() {
    extensionManager.onCmd("nat_type_check", async (msg, data) => {
      const intf = data.intf;
      let sourceIP = null;
      const intfObj = sysManager.getInterface(intf) || sysManager.getDefaultWanInterface();
      if (!intfObj || intfObj.type !== "wan" || !intfObj.ip_address)
        throw new Error(`Cannot find a WAN IP to use`);
      sourceIP = intfObj.ip_address;
      const servers = this.config.stunServers || DEFAULT_STUN_SERVERS;
      const stunServer = servers[Math.floor(Math.random() * servers.length)];
      log.info(`Select stun server ${stunServer.host}:${stunServer.port}`);
      let dstIP = new Address4(stunServer.host).isValid() ? stunServer.host : await exec(`dig +short +time=2 +tries=2 A ${stunServer.host} | tail -1`).then((result) => result.stdout.trim()).catch((err) => {
        log.error(`Failed to resolve ${stunServer.host} to IPv4 address`);
        return null;
      });
      if (!dstIP)
        throw new Error(`Cannot find available stun server`);
      const natType = await this.detectNatType(Buffer.from(uuid.parse(uuid.v4())), sourceIP, dstIP, stunServer.port);
      return natType;
    });
  }

  async detectNatType(transId, sourceIP, dstIP, dstPort) {
    // the discovery process is described in https://www.rfc-editor.org/rfc/rfc3489#section-10.1
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({type: "udp4"});
      socket.bind(0, sourceIP); // bind on random port
      let sourcePort = 0;
      socket.on('error', (err) => {
        log.error(`STUN socket error while talking to ${dstIP}:${dstPort}`, err.message);
        socket.close();
        resolve(NAT_TYPE_UNKNOWN);
      });
      socket.on('listening', () => {
        const address = socket.address();
        sourcePort = address.port;
      })
      const info = {
        addr1: null,
        caddr: null,
        cport: null,
      };
      let state = null;
      let timeout = null;
      socket.on('message', (message, rinfo) => {
        const serverIp = rinfo.address;
        const { mtype, mappedAddress, sourceAddress, changedIP, changedPort } = this.parseMessage(message, transId);
        if (mtype != MTYPE_BINDING_RESPONSE) {
          log.error(`received response but not binding response from ${serverIp}`);
          if (timeout)
            clearTimeout(timeout);
          socket.close();
          resolve(NAT_TYPE_UNKNOWN);
          return;
        }
        if (!mappedAddress || !changedIP || !changedPort) {
          log.error(`mapped address or changed IP or changed port is not returned in binding response from ${serverIp}`);
          if (timeout)
            clearTimeout(timeout);
          socket.close();
          resolve(NAT_TYPE_UNKNOWN);
          return;
        }
        switch (state) {
          case STATE_TEST_1: {
            if (sourceAddress !== `${dstIP}:${dstPort}`)
              return;
            if (mappedAddress === `${sourceIP}:${sourcePort}`) {
              clearTimeout(timeout);
              socket.close();
              resolve(NAT_TYPE_OPEN);
              return;
            }
            info.addr1 = mappedAddress;
            info.caddr = changedIP;
            info.cport = changedPort;
            state = STATE_TEST_2;
            socket.send(this.generateBindingRequestBuffer(transId, true, true), dstPort, dstIP);
            scheduleTimeout();
            break;
          }
          case STATE_TEST_2: {
            if (sourceAddress !== `${info.caddr}:${info.cport}`)
              return;
            clearTimeout(timeout);
            socket.close();
            resolve(NAT_TYPE_FULL_CONE);
            break;
          }
          case STATE_TEST_1_2: {
            if (sourceAddress !== `${info.caddr}:${info.cport}`)
              return;
            if (mappedAddress !== info.addr1) {
              clearTimeout(timeout);
              socket.close();
              resolve(NAT_TYPE_SYMMETRIC);
              return;
            }
            state = STATE_TEST_3;
            socket.send(this.generateBindingRequestBuffer(transId, false, true), dstPort, dstIP);
            scheduleTimeout();
            break;
          }
          case STATE_TEST_3: {
            if (sourceAddress !== `${dstIP}:${info.cport}`)
              return;
            clearTimeout(timeout);
            socket.close();
            resolve(NAT_TYPE_RESTRICTED_CONE);
            return;
          }
          default:
        }
      });

      const scheduleTimeout = () => {
        if (timeout)
          clearTimeout(timeout);
        timeout = setTimeout(() => {
          switch (state) {
            case STATE_TEST_1:
            case STATE_TEST_1_2: {
              log.error(`Response not received in test ${state}`);
              socket.close();
              resolve(NAT_TYPE_UNKNOWN);
              return;
            }
            case STATE_TEST_2: {
              state = STATE_TEST_1_2;
              socket.send(this.generateBindingRequestBuffer(transId, false, false), info.cport, info.caddr);
              scheduleTimeout();
              return;
            }
            case STATE_TEST_3: {
              socket.close();
              resolve(NAT_TYPE_PORT_RESTRICTED_CONE);
              return;
            }
          }
        }, 2000);
      };
      state = STATE_TEST_1;
      socket.send(this.generateBindingRequestBuffer(transId, false, false), dstPort, dstIP);
      scheduleTimeout();
    });
  }

  parseMessage(message, transId) { // message is a Buffer
    if (message.length < 20)
      return {};
    const mtype = message.readUInt16BE(0);
    const len = message.readUInt16BE(2);
    const tid = message.subarray(4, 20);
    if (!tid.equals(transId)) {
      log.error(`transaction id in received message mismatch`);
      return {};
    }
    if (mtype != MTYPE_BINDING_RESPONSE) {
      return { mtype };
    }
    let mappedAddress = null;
    let sourceAddress = null;
    let changedIP = null;
    let changedPort = null;
    let cursor = 20;
    while (cursor < len + 20) {
      if (message.length < cursor + 4)
        return {};
      const type = message.readUInt16BE(cursor, 2);
      const length = message.readUInt16BE(cursor + 2, 2);
      cursor += 4;
      if (message.length < cursor + length)
        return {};
      switch (type) {
        case ATTRTYPE_MAPPED_ADDRESS: {
          if (length != 8) {
            log.error(`wrong length of mapped address in binding response: ${length}`);
            return {};
          }
          mappedAddress = `${message.readUInt8(cursor + 4)}.${message.readUInt8(cursor + 5)}.${message.readUInt8(cursor + 6)}.${message.readUInt8(cursor + 7)}:${message.readUInt16BE(cursor + 2)}`;
          break;
        }
        case ATTRTYPE_SOURCE_ADDRESS: {
          if (length != 8) {
            log.error(`wrong length of source address in binding response: ${length}`);
            return {};
          }
          sourceAddress = `${message.readUInt8(cursor + 4)}.${message.readUInt8(cursor + 5)}.${message.readUInt8(cursor + 6)}.${message.readUInt8(cursor + 7)}:${message.readUInt16BE(cursor + 2)}`;
          break;
        }
        case ATTRTYPE_CHANGED_ADDRESS: {
          if (length != 8) {
            log.error(`wrong length of changed address in binding response: ${length}`);
            return {};
          }
          changedIP = `${message.readUInt8(cursor + 4)}.${message.readUInt8(cursor + 5)}.${message.readUInt8(cursor + 6)}.${message.readUInt8(cursor + 7)}`;
          changedPort = message.readUInt16BE(cursor + 2);
          break;
        }
      }
      cursor += length;
    }
    return { mtype, mappedAddress, sourceAddress, changedIP, changedPort };
  }

  generateBindingRequestBuffer(transId, changeIp, changePort) {
    const length = changeIp || changePort ? 8 : 0;
    const buffer = Buffer.alloc(length + 20);
    buffer.writeUInt16BE(MTYPE_BINDING_REQUEST, 0);
    buffer.writeUInt16BE(length, 2);
    transId.copy(buffer, 4, 0, 16);
    let value = 0x00000000;
    if (changeIp)
      value |= 0x4;
    if (changePort)
      value |= 0x2;
    if (value) {
      buffer.writeUInt16BE(ATTRTYPE_CHANGE_REQUEST, 20);
      buffer.writeUInt16BE(4, 22);
      buffer.writeUInt32BE(value, 24);
    }
    return buffer;
  }
}

module.exports = STUNSensor;