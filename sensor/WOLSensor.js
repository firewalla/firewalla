/*    Copyright 2016-2021 Firewalla Inc.
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

const sysManager = require('../net2/SysManager.js');
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();

const Sensor = require('./Sensor.js').Sensor;

const extensionManager = require('./ExtensionManager.js');
const _ = require('lodash');

const net = require('net');
const udp = require('dgram');

class WOLSensor extends Sensor {

  apiRun() {
    extensionManager.onCmd("wol:wake", (msg, data) => {
      const mac = msg.target;
      this.wake(mac, function(err, res){
        if (err) log.error("wake up fail.", err);
        log.info("wake up result: ", res);
      });
    })
  }

  createMagicPacket(mac){
    const MAC_REPEAT    = 16;
    const MAC_LENGTH    = 0x06;
    const PACKET_HEADER = 0x06;
    const parts  = mac.match(/[0-9a-fA-F]{2}/g);
    if(!parts || parts.length != MAC_LENGTH)
      throw new Error(`malformed MAC address "${mac}"`);
    var buffer = Buffer.alloc(PACKET_HEADER);
    var bufMac = Buffer.from(parts.map(p => parseInt(p, 16)));
    buffer.fill(0xff);
    for(var i = 0; i < MAC_REPEAT; i++){
      buffer = Buffer.concat([ buffer, bufMac ]);
    }
    return buffer;
  };

  async getBoxInterfaceIP(mac) {
    const ips = await hostTool.getIPsByMac(mac);
    if (_.isEmpty(ips)) {
      return null;
    }

    const ipv4 = ips[0];
    const intf = sysManager.getInterfaceViaIP(ipv4);
    if (!intf || !intf.ip_address) {
      return null;
    }

    return intf.ip_address;
  }

  async wake(mac, options, callback){
    options = options || {};
    if(typeof options == 'function'){
      callback = options;
    }
    const { address, port } = Object.assign({
      address : '255.255.255.255',
      port    : 9
    }, options);

    // to make sure box doesn't use other interface to send
    const boxIntfIP = await this.getBoxInterfaceIP(mac);
    if (!boxIntfIP) {
      callback && callback(null, "device not found");
      return;
    }

    // create magic packet
    const magicPacket = this.createMagicPacket(mac);
    const socket = udp.createSocket('udp4');
    socket.bind(0, boxIntfIP);
    socket.on('error', function(err){
      socket.close();
      callback && callback(err);
    }).once('listening', function(){
      socket.setBroadcast(true);
    });

    socket.send(
      magicPacket, 0, magicPacket.length, port, address,
      (err, res) => {
        const result = res == magicPacket.length ? "success" : "fail";
        socket.close();
        callback && callback(err, result);
    });
  };

}

module.exports = WOLSensor;
