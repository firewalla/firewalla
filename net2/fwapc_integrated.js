/*    Copyright 2019-2025 Firewalla Inc.
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

const log = require("./logger.js")(__filename);

const f = require('../net2/Firewalla.js');
const PlatformLoader = require('../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()
const Config = require('./config.js')
const { rrWithErrHandling } = require('../util/requestWrapper.js')

const util = require('util')
const rp = util.promisify(require('request'))
const _ = require('lodash');
const sysManager = require('./SysManager.js');
const Message = require('./Message.js');
const Constants = require("./Constants.js");
const fsp = require('fs').promises;
const exec = require('child-process-promise').exec;

// internal properties
let staStatus = null
let staStatusTs = 0;
const AP_INTF = "wlan1";

class IntegratedFWAPC {
  constructor() {
    log.info(`platform is: ${platform.constructor.name}`);
  }

  async apiCall(method, path, body) {
    if (method !== "GET") {
      log.error("Unsupported method for integrated FWAPC");
      return {code: 500, msg: "Unsupported method for integrated FWAPC"};
    }
    if (path.startsWith("/status/station")) {
      const mac = path.substring("/status/station/".length);
      if (!mac) {
        const status = await this.getAllSTAStatus();
        return {code: 200, body: status && {info: status, errors: []} || {}};
      }
      const status = await this.getSTAStatus(mac);
      return {code: 200, body: status && {info: status, errors: []} || {}};
    }
    log.error("Unsupported path for integrated FWAPC");
    return {code: 500, msg: "Unsupported path for integrated FWAPC"};
  }

  async getAllSTAStatus(live = false) {
    if (live || Date.now() / 1000 - staStatusTs > 15) {
      try {
        const { stdout: iwDevInfoOutput } = await exec(`sudo iw dev ${AP_INTF} info`);
        const iwDevInfo = this.parseIWDevInfo(iwDevInfoOutput);
        const { stdout } = await exec(`sudo hostapd_cli -i ${AP_INTF} -p ${f.getFireRouterRuntimeInfoFolder()}/hostapd all_sta`);
        staStatus = this.parseHostApdCliSTAs(stdout, AP_INTF, iwDevInfo.ssid, iwDevInfo.bssid, iwDevInfo.channel);
        staStatusTs = Date.now() / 1000;
      } catch (err) {
        log.error('Failed to get STA status:', err);
        staStatus = {};
      }
    }
    return Object.assign({}, staStatus);
  }

  async getSTAStatus(mac) {
    try {
      const { stdout: iwDevInfoOutput } = await exec(`sudo iw dev ${AP_INTF} info`);
      const iwDevInfo = this.parseIWDevInfo(iwDevInfoOutput);
      const { stdout } = await exec(`sudo hostapd_cli -i ${AP_INTF} -p ${f.getFireRouterRuntimeInfoFolder()}/hostapd sta ${mac}`);
      const result = this.parseHostApdCliSTAs(stdout, AP_INTF, iwDevInfo.ssid, iwDevInfo.bssid, iwDevInfo.channel);
      return result[mac.toUpperCase()] || null;
    } catch (err) {
      log.error('Failed to get STA status:', err);
    }
    return null;
  }

  parseHostApdCliSTAs(output, intf, ssid, bssid, channel) {
    const lines = output.trim().split('\n');
    const stas = {};
    let currentMac = null;
    let currentSta = {};
    const now = Math.round(Date.now() / 1000);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Check if line starts with a MAC address (format: xx:xx:xx:xx:xx:xx)
      const macMatch = trimmedLine.match(/^([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})$/);
      
      if (macMatch) {
        // Save previous station if exists
        if (currentMac) {
          stas[currentMac.toUpperCase()] = currentSta;
        }
        
        // Start new station
        currentMac = macMatch[1];
        currentSta = {intf, ssid, bssid, channel};
      } else {
        // Parse key=value pairs
        const equalIndex = trimmedLine.indexOf('=');
        if (equalIndex > 0) {
          const key = trimmedLine.substring(0, equalIndex);
          const value = trimmedLine.substring(equalIndex + 1);
          switch (key) {
            case 'signal':
              currentSta.rssi = Number(value);
              break;
            case 'wpa':
              currentSta.wpa = Number(value);
              currentSta.wpax = `wpa${value}_personal`;
              break;
            case 'tx_rate_info':
              currentSta.txRate = Math.round(Number(value) / 10);
              break;
            case 'rx_rate_info':
              currentSta.rxRate = Math.round(Number(value) / 10);
              break;
            case 'connected_time':
              currentSta.assocTs = now - Number(value);
              break;
            case 'inactive_msec':
              currentSta.idle = Math.round(Number(value) / 1000);
              break;
            default:
          }
        }
      }
    }

    // Don't forget the last station
    if (currentMac) {
      stas[currentMac.toUpperCase()] = currentSta;
    }

    return stas;
  }

  parseIWDevInfo(output) {
    const lines = output.trim().split('\n');
    const result = {};
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      
      // Find the first space to get the key and value
      const firstSpaceIndex = trimmedLine.indexOf(' ');
      if (firstSpaceIndex > 0) {
        const key = trimmedLine.substring(0, firstSpaceIndex);
        const value = trimmedLine.substring(firstSpaceIndex + 1).trim();
        switch (key) {
          case 'addr':
            result.bssid = value.toUpperCase;
            break;
          case 'ssid':
            result.ssid = value;
            break;
          case 'channel':
            result.channel = parseInt(value.split(' ')[0]);
            break;
        }
      }
    }

    return result;
  }
}

const instance = new IntegratedFWAPC();
module.exports = instance;
