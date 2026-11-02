/*    Copyright 2016-2024 Firewalla Inc.
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
const fsp = fs.promises
const net = require('net');
const spawn = require('child_process').spawn;
const log = require('../net2/logger.js')(__filename);
const f = require('../net2/Firewalla.js');
const Message = require('../net2/Message.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const LRU = require('lru-cache');
const { LimitedQueue } = require('./asyncNative.js');

// maxAge removes an entry only when it is read again, so cap the size; the kernel keeps at most
// 1024 neighbors per family by default (gc_thresh3)
const hitCache = new LRU({max: 4096, maxAge: 600000});
const missCache = new LRU({max: 4096, maxAge: 60000});

sem.on(Message.MSG_MAPPING_IP_MAC_DELETED, (event) => {
  const { ip, mac } = event
  if (mac && ip) {
    hitCache.del(ip);
    missCache.del(ip);
    // a neighbor looked up on a given interface is cached as `<intf>|<ip>`
    for (const cache of [hitCache, missCache])
      cache.keys().filter(key => key.endsWith(`|${ip}`)).forEach(key => cache.del(key));
  }
})

// IPv6 lookups come from per-flow paths: one probe per address at a time, a few at once,
// and none queued past a bound, so a burst of unknown addresses cannot pile up work
const PROBE_CONCURRENCY = 4;
const PROBE_BACKLOG_MAX = 100;
const probesInFlight = new Map();
const probeQueue = new LimitedQueue(({ ipv6Addr, intf }) => probeNeighbor(ipv6Addr, intf), PROBE_CONCURRENCY);

const permanentArpCache = {};
const { execFile } = require('child-process-promise');

const util = require('util')

// activeMacs is a hash. The key is MAC address and the value is an Object
// {"xx:xx:xx:xx:xx:xx": {ipv4Addr: "xx.xx.xx.xx", ipv6Addr: ["xx::xx", "yy::yy"]}}
async function updatePermanentArpEntries(activeMacs) {
  const entries = await fsp.readFile("/proc/net/arp", {encoding: "utf8"}).then((data) => data.trim().split("\n").map(line => {
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
      await execFile("sudo", ["arp", "-d", ipv4]).catch((err) => {
        log.error(`Failed to remove ARP entry of ${ipv4}`, err.message);
      });
      delete permanentArpCache[ipv4];
    }
  }
  const fileEntries = Object.keys(permanentArpCache).map(ipv4 => `${ipv4} ${permanentArpCache[ipv4].mac}`);
  log.verbose("Update arp cache with the following permanent entries", fileEntries);
  await fsp.writeFile(`${f.getHiddenFolder()}/run/permanent_arp_entries`, fileEntries.join("\n")).then(() => {
    execFile("sudo", ["arp", "-f", `${f.getHiddenFolder()}/run/permanent_arp_entries`]);
  }).catch((err) => {
    log.error("Failed to update arp cache", err.message);
  });
}

function getMAC(ipaddress, cb) {

  let _mac = hitCache.peek(ipaddress);
  if (_mac != null) {
      cb(false,_mac);
      return;
  }
  const notFoundRecently = missCache.peek(ipaddress);
  if (notFoundRecently) {
    cb(false, null);
    return;
  }

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
        const [ip, /* type */, flags, mac, /* mask */, /* intf */] = lines[i].replace(/ [ ]*/g, ' ').split(' ');
        if (!ip || !flags || !mac)
          continue;
        if (flags !== "0x0" && mac !== "00:00:00:00:00:00") {
          hitCache.set(ip, mac.toUpperCase());
          if (ip === ipaddress) {
            cb(false, mac.toUpperCase());
            resultReturned = true;
          }
        } else {
          missCache.set(ip, true);
          if (ip === ipaddress) {
            cb(false, null);
            resultReturned = true;
          }
        }
      }
      if (!resultReturned) {
        missCache.set(ipaddress, true);
        cb(false, null)
      }
    }
  });
}

// Never waits behind a network scan, so a caller holding a lock can use it.
// intf is required for a link-local address.
async function getMAC6Async(ipv6Addr, intf) {
  // a link-local address is only unique per interface
  const cacheKey = intf ? `${intf}|${ipv6Addr}` : ipv6Addr
  const cached = hitCache.peek(cacheKey);
  if (cached != null) {
    return cached
  }
  if (missCache.peek(cacheKey)) {
    return null
  }

  if (!net.isIPv6(ipv6Addr)) return null

  let probe = probesInFlight.get(cacheKey)
  if (!probe) {
    if (probeQueue.size >= PROBE_BACKLOG_MAX) {
      log.verbose('Neighbor probe backlog full, skip', ipv6Addr, intf)
      return null
    }
    probe = probeQueue.pushAndWait({ ipv6Addr, intf }).then(mac => {
      if (mac)
        hitCache.set(cacheKey, mac)
      else
        missCache.set(cacheKey, true)
      return mac
    }).finally(() => probesInFlight.delete(cacheKey))
    probesInFlight.set(cacheKey, probe)
  }
  return probe
}

async function probeNeighbor(ipv6Addr, intf) {
  const mac = await readNeighbor(ipv6Addr, intf)
  if (mac) return mac
  // sending to the address makes the kernel run neighbor discovery, and the entry resolves
  // from the advertisement even when the echo request itself is dropped
  const args = ['-c', '1', '-W', '1']
  if (intf) args.push('-I', intf)
  args.push(ipv6Addr)
  await execFile('ping6', args).catch(() => {})
  return readNeighbor(ipv6Addr, intf)
}

async function readNeighbor(ipv6Addr, intf) {
  const args = ['-6', 'neigh', 'show', ipv6Addr]
  if (intf) args.push('dev', intf)
  try {
    const { stdout } = await execFile('ip', args)
    // e.g. "fe80::1 dev eth0 lladdr 00:00:5e:00:53:01 router STALE", INCOMPLETE and FAILED carry no usable lladdr
    for (const line of stdout.split('\n')) {
      const match = line.match(/\blladdr ([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b.*\b(?:REACHABLE|STALE|DELAY|PROBE|PERMANENT)\b/i)
      if (match) return match[1].toUpperCase()
    }
  } catch (err) {
    log.warn('Failed to read neighbor cache', ipv6Addr, intf, err.message)
  }
  return null
}

module.exports = {
  getMAC:getMAC,
  getMACAsync: util.promisify(getMAC),
  getMAC6Async,
  updatePermanentArpEntries
}
