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

const log = require('../net2/logger.js')(__filename)

const Sensor = require('./Sensor.js').Sensor

const extensionManager = require('./ExtensionManager.js')

const net = require('net');
const udp = require('dgram');

class WOLSensor extends Sensor {

  apiRun() {
    extensionManager.onCmd("wol:wake", (msg, data) => {
      const mac = msg.target;
      this.wake(mac, function(err, res){
        if (err) log.error("wake up fail.", err)
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

  wake(mac, options, callback){
    options = options || {};
    if(typeof options == 'function'){
      callback = options;
    }
    const { address, port } = Object.assign({
      address : '255.255.255.255',
      port    : 9
    }, options);
    // create magic packet
    var magicPacket = this.createMagicPacket(mac);
    var socket = udp.createSocket(
      net.isIPv6(address) ? 'udp6' : 'udp4'
    ).on('error', function(err){
      socket.close();
      callback && callback(err);
    }).once('listening', function(){
      socket.setBroadcast(true);
    });
    return new Promise((resolve, reject) => {
      socket.send(
        magicPacket, 0, magicPacket.length,
        port, address, function(err, res){
          let result = res == magicPacket.length;
          if(err) reject(err);
          else resolve(result);
          callback && callback(err, result);
          socket.close();
      });
    });
  };

}

module.exports = WOLSensor;
