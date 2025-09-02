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


const OUI_FILE_PATH = "/usr/share/nmap/nmap-mac-prefixes";


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

  static async lookupMacVendor(mac, minimalMatchLen, ouiFile = OUI_FILE_PATH) {
    try {
      if (!mac || mac.length < minimalMatchLen) {
        return null;
      }
      const macBuff = Buffer.from(mac.replace(/:/g, '').toUpperCase());

      const fileStream = fs.createReadStream(ouiFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      let maxMatchLen = 0;
      let vendorName = null;
      for await (const line of rl) {
        const parsed = WlanVendorInfo.parseOuiLine(line, minimalMatchLen);
        if (!parsed) continue;
        const num = Math.min(parsed.oui.length, macBuff.length);
        let matchLen = 0;
        while (matchLen < num && parsed.oui[matchLen] === macBuff[matchLen]) {
          matchLen++;
        }
        if (matchLen >= minimalMatchLen && matchLen > maxMatchLen) {
          maxMatchLen = matchLen;
          vendorName = parsed.vendorName;
        }
      }
      return vendorName;
    } catch (err) {
      console.error(`Failed to read OUI file ${ouiFile}`, err.message);
      console.error(err.stack);
      return null;
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