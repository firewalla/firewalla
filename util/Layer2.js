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

'use strict'

const fs = require('fs');
const spawn = require('child_process').spawn;
const log = require('../net2/logger.js')(__filename);

const _SimpleCache = require('../util/SimpleCache.js')
const SimpleCache = new _SimpleCache("macCache",60*10);
const notFoundCache = new _SimpleCache("notFoundCache", 60); // do not repeatedly invoke cat /proc/net/arp for the same IP address

const util = require('util')

function getMAC(ipaddress, cb) {

  let _mac = SimpleCache.lookup(ipaddress);
  if (_mac != null) {
      cb(false,_mac);
      return;
  }
  const notFoundRecently = notFoundCache.lookup(ipaddress);
  if (notFoundRecently) {
    cb(false, null);
    return;
  }

  // ping the ip address to encourage the kernel to populate the arp tables
  let ping = spawn("ping", ["-c", "1", "-W", "1", ipaddress ]);

  ping.on('exit', function () {
    // not bothered if ping did not work
    fs.readFile('/proc/net/arp', (err, data) => {
      let i, lines;
      if (err) {
        log.error("Failed to read /proc/net/arp", err.message);
        cb(true, err.message);
      } else {
        lines = data.toString().split('\n');
        let resultReturned = false;
        for (i = 0; i < lines.length; i++) {
          if (i === 0)
            continue;
          const [ ip, /* type */, flags, mac, /* mask */, /* intf */ ] = lines[i].replace(/ [ ]*/g, ' ').split(' ');
          if (!ip || !flags || !mac)
            continue;
          if (flags !== "0x0" && mac !== "00:00:00:00:00:00") {
            SimpleCache.insert(ip, mac.toUpperCase());
            if (ip === ipaddress) {
              cb(false, mac.toUpperCase());
              resultReturned = true;
            }
          } else {
            notFoundCache.insert(ip, true);
            if (ip === ipaddress) {
              cb(false, null);
              resultReturned = true;
            }
          }
        }
        if (!resultReturned) {
          notFoundCache.insert(ipaddress, true);
          cb(false, null)
        }
      }
    });
  });
}

module.exports = {
  getMAC:getMAC,
  getMACAsync: util.promisify(getMAC)
}
