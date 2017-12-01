/*    Copyright 2016 Firewalla LLC
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

'use strict'

let spawn = require('child_process').spawn;
let log = require('../net2/logger.js')(__filename);

let _SimpleCache = require('../util/SimpleCache.js')
let SimpleCache = new _SimpleCache("macCache",60*10);

const Promise = require('bluebird')

function getMACAndVendor(ipaddress, cb) {

  // get MAC Address first
  let mac_address = null;
  let mac_address_vendor = null;
  getMAC(ipaddress, (err, result) => {
    if(err) {
      log.error("Failed to get MAC Address for IP " + host.ipv4Addr + ", err: " + err);
      cb(err);
      return;
    } else {
      mac_address = result;
    }

    // get MAC OU company
    cb(err, {mac_address: mac_address});
    /*
    mac.lookup(mac_address, (err, result) => {
      if(err) {
        log.error("Failed to get vendor info for MAC " + mac_address + ", err: " + err);
      } else {
        mac_address_vendor = result;
      }

      cb(err, {mac_address: mac_address, mac_address_vendor: mac_address_vendor});
    });
    */
  });
}

function getMAC(ipaddress, cb) {

  let _mac = SimpleCache.lookup(ipaddress);
  if (_mac != null) {
      cb(false,_mac);
      return;
  }
  // ping the ip address to encourage the kernel to populate the arp tables
  let ping = spawn("ping", ["-c", "1", ipaddress ]);

  ping.on('exit', function (code) {
    // not bothered if ping did not work

    let arp = spawn("cat", ["/proc/net/arp"] );
    let buffer = '';
    let errstream = '';
    arp.stdout.on('data', function (data) {
      buffer += data;
    });
    arp.stderr.on('data', function (data) {
      errstream += data;
    });

    arp.on('close', function (code) {
      if (code != 0) {
	      log.info("Error running arp " + code + " " + errstream);
	      cb(true, code);
      }
      let table = buffer.split('\n');
      for ( let l = 0; l < table.length; l++) {

	// parse this format
	//IP address       HW type     Flags       HW address            Mask     Device
	//192.168.1.1      0x1         0x2         50:67:f0:8c:7a:3f     *        em1

        if (l == 0) continue;

        if (table[l].indexOf(ipaddress + " ") == 0) {
          let mac = table[l].substring(41, 58).toUpperCase().trim();
          if (mac == "00:00:00:00:00:00") {
             cb(false,null);
             return;
          }
          SimpleCache.insert(ipaddress,mac); 
          cb(false, mac);
          return;
        }
      }
      cb(false, null)
//      cb(true, "Count not find ip in arp table: " + ipaddress);
    });
  });
}

module.exports = {
  getMAC:getMAC,
  getMACAsync: Promise.promisify(getMAC),
  getMACAndVendor:getMACAndVendor
}
