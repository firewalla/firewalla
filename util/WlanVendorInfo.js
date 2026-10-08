/*    Copyright 2016-2025 Firewalla Inc.
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


const fs = require('fs');
const readline = require('readline');


// Overwritten in place with `cp -f` by the asset post-download hook and by NmapSensor.run(), never
// swapped atomically, so a lookup running during an update can read a partially written file.
const OUI_FILE_PATH = "/usr/share/nmap/nmap-mac-prefixes";

// Lines in nmap-mac-prefixes are at most about 120 bytes, so one read of this size holds a whole line.
const OUI_READ_SIZE = 512;
const NEWLINE = 0x0a;
// Holder of every 24-bit OUI that MA-M and MA-S blocks are carved from
const IEEE_RA_VENDOR = 'IEEE Registration Authority';

// nmap-mac-prefixes order: by prefix length, then by prefix.
function compareOuiPrefix(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : (a > b ? 1 : 0);
}

async function nextLineStart(fh, offset, size, buf) {
  let pos = offset;
  while (pos < size) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    if (bytesRead <= 0) return null;
    const nl = buf.subarray(0, bytesRead).indexOf(NEWLINE);
    if (nl >= 0) return pos + nl + 1;
    pos += bytesRead;
  }
  return null;
}

// The first entry line starting at or after `offset`, as { prefix, vendorName, next } where `next` is
// the offset of the following line. Blank and '#' lines are skipped, as nmap skips them. `offset` is a
// line start when it is 0 or follows '\n'; otherwise the search moves to the next line.
async function readOuiLineAt(fh, offset, size, buf) {
  let start = offset;
  if (start > 0 && start < size) {
    const { bytesRead } = await fh.read(buf, 0, 1, start - 1);
    if (bytesRead === 1 && buf[0] !== NEWLINE) {
      start = await nextLineStart(fh, start, size, buf);
      if (start === null) return null;
    }
  }
  while (start < size) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    if (bytesRead <= 0) return null;
    const nl = buf.subarray(0, bytesRead).indexOf(NEWLINE);
    const line = buf.toString('utf8', 0, nl >= 0 ? nl : bytesRead).trim();
    let next;
    if (nl >= 0) {
      next = start + nl + 1;
    } else {
      // the last line without a trailing newline, or a line longer than the buffer
      next = await nextLineStart(fh, start + bytesRead, size, buf);
      if (next === null) next = size;
    }
    if (line.length > 0 && !line.startsWith('#')) {
      const sp = line.indexOf(' ');
      return {
        prefix: (sp < 0 ? line : line.substring(0, sp)).toUpperCase(),
        vendorName: sp < 0 ? '' : line.substring(sp + 1).trim(),
        next
      };
    }
    start = next;
  }
  return null;
}

// Binary search over byte offsets for the line whose prefix equals `prefix`. `lo` is always a line
// start, and the first line not less than `prefix` starts between `lo` and `hi`.
async function findOuiLine(fh, size, buf, prefix) {
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const line = await readOuiLineAt(fh, mid, size, buf);
    if (!line || compareOuiPrefix(line.prefix, prefix) >= 0) {
      hi = mid;
    } else {
      lo = line.next;
    }
  }
  const line = await readOuiLineAt(fh, lo, size, buf);
  return line && line.prefix === prefix ? line : null;
}


class WlanVendorInfo {
  constructor(hexVendorId) {
    this.hexVendorId = hexVendorId;
    this.vendorIdBuff = Buffer.from(hexVendorId);
    this.maxMatchLen = 0;
    this.vendorName = "Unknown";
  }

  static parseOuiLine(line, minimalMatchLen) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) return null;
  
    const index = trimmedLine.indexOf(' ');
    if (index < minimalMatchLen) return null;
  
    const oui = trimmedLine.substring(0, index);
    const vendorName = trimmedLine.substring(index + 1).trim();
    return { oui: Buffer.from(oui), vendorName };
  }

  // Vendor of the longest entry that is a prefix of the MAC, found by binary search instead of reading
  // the whole file. It depends on the order nmap-mac-prefixes is shipped in: every 6-digit (MA-L) line,
  // then every 7-digit (MA-M) line, then every 9-digit (MA-S) line, each group sorted. In a file with
  // another order, lookups miss. Nothing is kept between calls, and each call reads the file as it is
  // at that moment.
  //
  // The MA-L entry is searched first. IEEE carves MA-M and MA-S blocks only out of OUIs it keeps for
  // itself and never reassigns (IEEE RA, "Guidelines for Use of EUI, OUI, and CID"), so an MA-L entry
  // held by any other vendor has no smaller block under it and is the answer. That takes one search
  // for most MACs; the MA-S and MA-M searches run only when the MA-L entry is IEEE's or missing.
  static async lookupMacVendor(mac, ouiFile = OUI_FILE_PATH) {
    const hex = typeof mac === 'string' ? mac.replace(/:/g, '').toUpperCase() : '';
    if (!/^[0-9A-F]{12}$/.test(hex)) return null;

    let fh = null;
    try {
      fh = await fs.promises.open(ouiFile, 'r');
      const { size } = await fh.stat();
      const buf = Buffer.alloc(OUI_READ_SIZE);
      const large = await findOuiLine(fh, size, buf, hex.substring(0, 6));
      if (large && large.vendorName !== IEEE_RA_VENDOR) return large.vendorName;
      for (const len of [9, 7]) {
        const line = await findOuiLine(fh, size, buf, hex.substring(0, len));
        if (line) return line.vendorName;
      }
      return large ? large.vendorName : null;
    } catch (err) {
      console.error(`Failed to read OUI file ${ouiFile}`, err.message);
      return null;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  static async lookupWlanVendorInfos(macVendorMap, minimalMatchLen, ouiFile = OUI_FILE_PATH) {

    try {
      const fileStream = fs.createReadStream(ouiFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        const parsed = WlanVendorInfo.parseOuiLine(line, minimalMatchLen);
        if (!parsed) continue;

        for (let [_mac, wlanVendorList] of macVendorMap) {

          for (let i = 0; i < wlanVendorList.length; i++) {
            let wlanVendorInfo = wlanVendorList[i];
            const num = Math.min(parsed.oui.length, wlanVendorInfo.vendorIdBuff.length);
            let matchLen = 0;
            while (matchLen < num && parsed.oui[matchLen] === wlanVendorInfo.vendorIdBuff[matchLen]) {
              matchLen++;
            }

            if (matchLen >= minimalMatchLen && matchLen > wlanVendorInfo.maxMatchLen) {
              wlanVendorInfo.maxMatchLen = matchLen;
              wlanVendorInfo.vendorName = parsed.vendorName;
              wlanVendorList[i] = wlanVendorInfo;
            }
          }
        }
      }
    } catch (err) {
      console.error(`Failed to read OUI file ${ouiFile}`, err.message);
      console.error(err.stack);
    }
  }
  
  
  static async lookupWlanVendors(macVendorPairs, ouiFile = OUI_FILE_PATH) {
    if (!macVendorPairs || macVendorPairs.size == 0) {
      //macVendorPairs is empty, return empty map
      return {};
    }
    let macVendorMap = new Map();
    const miniVendorLen = 6; // minimum vendor length to match vendor info in OUI file
  
    // initialize vendor info map
    for (const pair of macVendorPairs) {
      const mac = pair.mac;
      const vendor = pair.vendor;
      if (!mac || !vendor) {
        continue;
      }
      let fullHexVendor = vendor.trim().toUpperCase();
      if (fullHexVendor.length < miniVendorLen) {
        continue;
      }
      let hexVendorIds = fullHexVendor.split(' ');
      let wlanVendorList = [];
      for (let hexVendorId of hexVendorIds) {
        hexVendorId = hexVendorId.trim();
        if (hexVendorId.length < miniVendorLen) {
          continue;
        }
        hexVendorId = hexVendorId.startsWith('0X') ? hexVendorId.substring(2) : hexVendorId;
        if (hexVendorId.length < miniVendorLen) {
          continue;
        }
        let wlanVendorInfo = new WlanVendorInfo(hexVendorId);
        wlanVendorList.push(wlanVendorInfo);
      }
      macVendorMap.set(mac, wlanVendorList);
    }
    await WlanVendorInfo.lookupWlanVendorInfos(macVendorMap, miniVendorLen, ouiFile);

    return macVendorMap;

  }

  static getVendorFromVendorMap(macVendorMap, mac) {
    let wlanVendorInfoList = macVendorMap.get(mac);
    if (!wlanVendorInfoList) {
      return null;
    }
    const wlanVendors = wlanVendorInfoList.filter(v => v.vendorName !== "Unknown").map(v => v.vendorName);
    if (wlanVendors.length > 0) {
      return wlanVendors;
    }
    return null;
  }

}



module.exports = WlanVendorInfo;