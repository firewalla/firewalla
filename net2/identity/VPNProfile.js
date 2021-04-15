/*    Copyright 2021 Firewalla Inc
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

const log = require('../logger.js')(__filename);

const { Address4, Address6 } = require('ip-address');
const sysManager = require('../SysManager.js');
const platform = require('../../platform/PlatformLoader.js').getPlatform();

const Promise = require('bluebird');
const DNSMASQ = require('../../extension/dnsmasq/dnsmasq.js');
const f = require('../Firewalla.js');
const fs = require('fs');
Promise.promisifyAll(fs);
const Constants = require('../Constants.js');
const VpnManager = require('../../vpn/VpnManager.js');
const NetworkProfile = require('../NetworkProfile.js');

const Identity = require('../Identity.js');

const vpnProfiles = {};

class VPNProfile extends Identity {
  getUniqueId() {
    return this.o && this.o.cn;
  }

  static getNamespace() {
    return Constants.NS_VPN_PROFILE;
  }

  static getKeyOfUIDInAlarm() {
    return "p.device.vpnProfile";
  }

  static getKeyOfInitData() {
    return "vpnProfiles";
  }

  static getDnsmasqConfigDirectory(uid) {
    if (platform.isFireRouterManaged()) {
      const vpnIntf = sysManager.getInterface("tun_fwvpn");
      const vpnIntfUUID = vpnIntf && vpnIntf.uuid;
      if (vpnIntfUUID && sysManager.getInterfaceViaUUID(vpnIntfUUID)) {
        return `${NetworkProfile.getDnsmasqConfigDirectory(vpnIntfUUID)}`;
      }
    }
    return super.getDnsmasqConfigDirectory(uid);
  }

  static async getInitData() {
    const allSettings = await super.getInitData();
    const statistics = await new VpnManager().getStatistics();
    const vpnProfiles = [];
    for (const cn of Object.keys(allSettings)) {
      const timestamp = await VpnManager.getVpnConfigureTimestamp(cn);
      vpnProfiles.push({
        cn: cn,
        settings: allSettings[cn],
        connections: statistics && statistics.clients && Array.isArray(statistics.clients) && statistics.clients.filter(c => (cn === "fishboneVPN1" && c.cn.startsWith(cn)) || c.cn === cn) || [],
        timestamp: timestamp
      });
    }
    return vpnProfiles;
  }

  static async getIdentities() {
    const allProfiles = await VpnManager.getAllSettings();
    for (const cn in allProfiles) {
      const o = allProfiles[cn];
      o.cn = cn;
      if (vpnProfiles[cn]) {
        vpnProfiles[cn].update(o);
      } else {
        vpnProfiles[cn] = new VPNProfile(o);
      }
      vpnProfiles[cn].active = true;
    }

    const removedProfiles = {};
    Object.keys(vpnProfiles).filter(cn => vpnProfiles[cn].active === false).map((cn) => {
      removedProfiles[cn] = vpnProfiles[cn];
    });
    for (let cn in removedProfiles) {
      delete vpnProfiles[cn];
    }
    return vpnProfiles;
  }

  static async getIPUniqueIdMappings() {
    const statistics = await new VpnManager().getStatistics();
    if (!statistics || !statistics.clients) {
      return {};
    }
    const clients = statistics.clients;
    const ipUidMap = {};
    for (const client of clients) {
      if (!client.vAddr || !client.cn)
        continue;
      for (const addr of client.vAddr) {
        if (new Address4(addr).isValid())
          ipUidMap[addr] = client.cn;
      }
    }
    return ipUidMap;
  }

  static async getIPEndpointMappings() {
    const statistics = await new VpnManager().getStatistics();
    if (!statistics || !statistics.clients) {
      return {};
    }
    const clients = statistics.clients;
    const ipEndpointMap = {};
    for (const client of clients) {
      if (!client.vAddr || !client.addr)
        continue;
      for (const addr of client.vAddr) {
        if (new Address4(addr).isValid())
          ipEndpointMap[addr] = client.addr;
      }
    }
    return ipEndpointMap;
  }

  static getRefreshIdentitiesHookEvents() {
    return ["VPNProfiles:Updated"];
  }

  static getRefreshIPMappingsHookEvents() {
    return ["VPNConnectionAccepted"];
  }

  getLocalizedNotificationKeySuffix() {
    return ".ovpn";
  }

  getDeviceNameInNotificationContent(alarm) {
    if (this.getUniqueId() === Constants.DEFAULT_VPN_PROFILE_CN && alarm["p.device.real.ip"])
      return alarm["p.device.real.ip"].split(":")[0];
    else
      return alarm["p.device.name"];
  }

  getReadableName() {
    return this.o && (this.o.name || this.o.clientBoxName) || this.getUniqueId();
  }

  getNicName() {
    return "tun_fwvpn";
  }
}

module.exports = VPNProfile;