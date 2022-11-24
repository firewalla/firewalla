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
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const f = require('../net2/Firewalla.js');

const _SimpleCache = require('../util/SimpleCache.js')
const SimpleCache = new _SimpleCache("macCache",60*10);
const notFoundCache = new _SimpleCache("notFoundCache", 60); // do not repeatedly invoke cat /proc/net/arp for the same IP address

const permanentArpCache = {};
const exec = require('child-process-promise').exec;

const util = require('util')

// activeMacs is a hash. The key is MAC address and the value is an Object
// {"xx:xx:xx:xx:xx:xx": {ipv4Addr: "xx.xx.xx.xx", ipv6Addr: ["xx::xx", "yy::yy"]}}
async function updatePermanentArpEntries(activeMacs) {
  const entries = await fs.readFileAsync("/proc/net/arp", {encoding: "utf8"}).then((data) => data.trim().split("\n").map(line => {
    const [ ip, /* type */, flags, mac, /* mask */, /* intf */ ] = line.replace(/ [ ]*/g, ' ').split(' ');
    return {ip, flags, mac}
  })).catch((err) => {
    log.error("Failed to read /proc/net/arp in updatePermanentArpEntries", err.message);
    return [];
  });
  // update permanentArpCache from existing permanent ARP entries in arp cache
  const danglingPermanentEntries = entries.filter(entry => entry.flags === "0x6" && entry.mac !== "00:00:00:00:00:00" && !Object.keys(permanentArpCache).includes(entry.ip));
  for (const danglingEntry of danglingPermanentEntries) {
    permanentArpCache[danglingEntry.ip] = {
      mac: danglingEntry.mac,
      timestamp: Date.now() / 1000
    };
  }
  // update permanentArpCache from activeMacs
  for (const mac of Object.keys(activeMacs)) {
    const ipv4 = activeMacs[mac] && activeMacs[mac].ipv4Addr;
    if (ipv4 && !entries.some(entry => entry.ip === ipv4 && entry.mac === mac && (entry.flags === "0x2" || entry.flags === "0x6"))) {
      permanentArpCache[ipv4] = {
        mac: mac,
        timestamp: Date.now() / 1000
      }
    }
  }
  // purge out-dated entries from permanentArpCache
  for (const ipv4 of Object.keys(permanentArpCache)) {
    const timestamp = permanentArpCache[ipv4] && permanentArpCache[ipv4].timestamp;
    if (timestamp && Date.now() / 1000 - timestamp > 3600) {
      log.info(`An out-dated permanent ARP entry is removed: ${ipv4} --> ${permanentArpCache[ipv4].mac}`)
      await exec(`sudo arp -d ${ipv4}`).catch((err) => {
        log.error(`Failed to remove ARP entry of ${ipv4}`, err.message);
      });
      delete permanentArpCache[ipv4];
    }
  }
  const fileEntries = Object.keys(permanentArpCache).map(ipv4 => `${ipv4} ${permanentArpCache[ipv4].mac}`);
  log.info("Update arp cache with the following permanent entries", fileEntries);
  await fs.writeFileAsync(`${f.getHiddenFolder()}/run/permanent_arp_entries`, fileEntries.join("\n")).then(() => {
    exec(`sudo arp -f ${f.getHiddenFolder()}/run/permanent_arp_entries`);
  }).catch((err) => {
    log.error("Failed to update arp cache", err.message);
  });
}

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
  getMACAsync: util.promisify(getMAC),
  updatePermanentArpEntries
}
