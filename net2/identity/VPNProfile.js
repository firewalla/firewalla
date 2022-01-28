/*    Copyright 2021-2022 Firewalla Inc.
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
const rclient = require('../../util/redis_manager.js').getRedisClient();

const Constants = require('../Constants.js');
const VpnManager = require('../../vpn/VpnManager.js');
const NetworkProfile = require('../NetworkProfile.js');
const Message = require('../Message.js');

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
      const lastActiveTimestamps = statistics && statistics.clients && Array.isArray(statistics.clients) && statistics.clients.filter(c => (cn === "fishboneVPN1" && c.cn.startsWith(cn)) || c.cn === cn).map(c => c.lastActive) || [];
      vpnProfiles.push({
        uid: cn,
        cn: cn,
        settings: allSettings[cn],
        connections: statistics && statistics.clients && Array.isArray(statistics.clients) && statistics.clients.filter(c => (cn === "fishboneVPN1" && c.cn.startsWith(cn)) || c.cn === cn) || [],
        lastActiveTimestamp: lastActiveTimestamps.length > 0 ? Math.max(...lastActiveTimestamps) : null,
        timestamp: timestamp
      });
    }
    return vpnProfiles;
  }

  static async getIdentities() {
    for (const cn of Object.keys(vpnProfiles))
      vpnProfiles[cn].active = false;

    const allProfiles = await VpnManager.getAllSettings();
    for (const cn in allProfiles) {
      const o = allProfiles[cn];
      o.cn = cn;
      if (vpnProfiles[cn]) {
        await vpnProfiles[cn].update(o);
      } else {
        vpnProfiles[cn] = new VPNProfile(o);
      }
      vpnProfiles[cn].active = true;
    }

    for (const cn of Object.keys(vpnProfiles)) {
      if (vpnProfiles[cn].active === false) {
        delete vpnProfiles[cn]
        continue
      }

      const redisMeta = await rclient.hgetallAsync(vpnProfiles[cn].getMetaKey())
      Object.assign(vpnProfiles[cn].o, VPNProfile.parse(redisMeta))
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
    return [Message.MSG_OVPN_PROFILES_UPDATED];
  }

  static getRefreshIPMappingsHookEvents() {
    return [Message.MSG_OVPN_CONN_ACCEPTED];
  }

  getLocalizedNotificationKeySuffix() {
    return ".ovpn";
  }

  getDeviceNameInNotificationContent(alarm) {
    if (this.getUniqueId() === Constants.DEFAULT_VPN_PROFILE_CN && alarm["p.device.real.ip"]) {
      const endpoint = alarm["p.device.real.ip"];
      return endpoint.startsWith("[") && endpoint.includes("]:") ? endpoint.substring(1, endpoint.indexOf("]:")) : endpoint.split(":")[0];
    }
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
