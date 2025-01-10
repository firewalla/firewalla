'use strict';


const fs = require('fs');
const readline = require('readline');
const OUI_FILE_PATH = "/usr/share/nmap/nmap-mac-prefixes";

class WlanVendorInfo {
  constructor(fullHexVendor, sigVendorIdBuff) {
    this.fullHexVendor = fullHexVendor;
    this.sigVendorIdBuff = sigVendorIdBuff; // take first vendor id as the significant vendor id
    this.vendorName = null;
    this.maxMatchLen = 0;
  }

  static async lookupWlanVendorInfos(wlanVendorInfoMap, minimalMatchLen, ouiFile = OUI_FILE_PATH) {

    try {
      const fileStream = fs.createReadStream(ouiFile);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      for await (let line of rl) {
        line = line.trim();
        if (line.length == 0) {
          continue; // skip empty line
        }
        const index = line.indexOf(' ');
        if (index < minimalMatchLen) {
          continue; // less than minimal match length, skip invalid line
        }
        const ouiBuff = Buffer.from(line.substring(0, index));
        for (let [vendorKey, vendorInfo] of wlanVendorInfoMap) {
          const sigVendorIdBuff = vendorInfo.sigVendorIdBuff;
          const num = Math.min(ouiBuff.length, sigVendorIdBuff.length);
  
          for (let i=0; i<num; i++) {
            if (sigVendorIdBuff[i] != ouiBuff[i]) {
              const match = i;
              if (vendorInfo.maxMatchLen < match && match >= minimalMatchLen) {
                vendorInfo.maxMatchLen = match;
                vendorInfo.vendorName = line.substring(index + 1).trim();
                wlanVendorInfoMap.set(vendorKey, vendorInfo);
              }
              break;
            }
            if (i == num-1) { // all bytes match
              const match = num;
              if (vendorInfo.maxMatchLen < match && match >= minimalMatchLen) {
                vendorInfo.maxMatchLen = match;
                vendorInfo.vendorName = line.substring(index + 1).trim();
                wlanVendorInfoMap.set(vendorKey, vendorInfo);
              }
              break;
            }
          }
        }
      }
    } catch (err) {
      console.error(`Failed to read OUI file ${ouiFile}`, err.message);
    }
  }
  
  
  static async lookupWlanVendors(macVendorPairs, ouiFile = OUI_FILE_PATH) {
    if (!macVendorPairs || macVendorPairs.size == 0) {
      //macVendorPairs is empty, return empty map
      return {};
    }
    let wlanVendorInfoMap = new Map();
    const miniVendorLen = 6; // minimum vendor length to match vendor info in OUI file
  
    // initialize vendor info map
    for (const pair of macVendorPairs) {
      const mac = pair.mac;
      const vendor = pair.vendor;
      let fullHexVendor = vendor.trim().toUpperCase();
      if (fullHexVendor.length < miniVendorLen) {
        continue;
      }
      const hexVendorInfoStrs = fullHexVendor.split(' ');
  
      let firstHexVendor = hexVendorInfoStrs[0].trim(); // the first vendor info is the most significant, omit the 0x prefix
      if (firstHexVendor.length < miniVendorLen) {
        // The first vendor id is too short, skip
        continue;
      }
      firstHexVendor = firstHexVendor.startsWith('0X') ? firstHexVendor.substring(2) : firstHexVendor;

      if (firstHexVendor.length < miniVendorLen) {
        // The first vendor id is too short after removing 0x prefix, skip lookup
        continue;
      }
      const sigVendorIdBuff = Buffer.from(firstHexVendor); // used for best match
  
      let wlanVendorInfo = new WlanVendorInfo(fullHexVendor, sigVendorIdBuff);
      wlanVendorInfoMap.set(mac, wlanVendorInfo);
    }
    await WlanVendorInfo.lookupWlanVendorInfos(wlanVendorInfoMap, miniVendorLen, ouiFile);
  
    return wlanVendorInfoMap;
  }


}



module.exports = WlanVendorInfo;