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

'use strict';

const exec = require('child-process-promise').exec;
const log = require('../../net2/logger.js')(__filename);
const fc = require('../../net2/config.js');
const f = require('../../net2/Firewalla.js');
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const sem = require('../../sensor/SensorEventManager.js').getInstance();
const _ = require('lodash');
const sclient = require('../../util/redis_manager.js').getSubscriptionClient();
const vpnClientEnforcer = require('./VPNClientEnforcer.js');
const routing = require('../routing/routing.js');
const iptables = require('../../net2/Iptables.js');
const {Address4} = require('ip-address');
const sysManager = require('../../net2/SysManager');
const ipTool = require('ip');

const instances = {};

class VPNClient {
  constructor(options) {
    const profileId = options.profileId;
    if (!profileId)
      return null;
    if (!instances[profileId]) {
      instances[profileId] = this;
      this.profileId = profileId;
      if (f.isMain()) {
        this.hookLinkStateChange();
        this.hookSettingsChange();

        setInterval(() => {
          this._checkConnectivity().catch((err) => {
            log.error(`Failed to check connectivity on VPN client ${this.profileId}`, err.message);
          });
        }, 60000);

        if (this._getRedisRouteUpMessageChannel()) {
          const channel = this._getRedisRouteUpMessageChannel();
          sclient.on("message", (c, message) => {
            if (c === channel && message === this.profileId) {
              log.info(`VPN client ${this.profileId} route is up, will refresh routes ...`);
              this._refreshRoutes().catch((err) => {
                log.error(`Failed to refresh routes on VPN client ${this.profileId}`, err.message);
              });
              // emit link established event immediately
              sem.emitEvent({
                type: "link_established",
                profileId: this.profileId
              });
            }
          });
          sclient.subscribe(channel);
        }
      }
    }
    return instances[profileId];
  }

  _getRedisRouteUpMessageChannel() {
    return null;
  }

  async _refreshRoutes() {
    if (!this._started)
      return;
    const isUp = await this._isLinkUp();
    if (!isUp) {
      log.error(`VPN client ${this.profileId} is not up, skip refreshing routes`);
      return;
    }
    const remoteIP = await this._getRemoteIP();
    const intf = this.getInterfaceName();
    await exec(iptables.wrapIptables(`sudo iptables -w -t nat -A FW_POSTROUTING -o ${intf} -j MASQUERADE`)).catch((err) => {});
    log.info(`Refresh OpenVPN client routes for ${this.profileId}, remote: ${remoteIP}, intf: ${intf}`);
    const settings = await this.loadSettings();
    // remove routes from main table which is inserted by VPN client automatically,
    // otherwise tunnel will be enabled globally
    await routing.removeRouteFromTable("0.0.0.0/1", remoteIP, intf, "main").catch((err) => { log.info("No need to remove 0.0.0.0/1 for " + this.profileId) });
    await routing.removeRouteFromTable("128.0.0.0/1", remoteIP, intf, "main").catch((err) => { log.info("No need to remove 128.0.0.0/1 for " + this.profileId) });
    await routing.removeRouteFromTable("default", remoteIP, intf, "main").catch((err) => { log.info("No need to remove default route for " + this.profileId) });
    let routedSubnets = settings.serverSubnets || [];
    // add vpn client specific routes
    try {
      const vpnSubnets = await this.getRoutedSubnets();
      if (vpnSubnets && _.isArray(vpnSubnets))
        routedSubnets = routedSubnets.concat(vpnSubnets);
    } catch (err) {
      log.error('Failed to parse VPN subnet', err.message);
    }
    await vpnClientEnforcer.enforceVPNClientRoutes(remoteIP, intf, routedSubnets, settings.overrideDefaultRoute == true);
    // loosen reverse path filter
    await exec(`sudo sysctl -w net.ipv4.conf.${intf}.rp_filter=2`).catch((err) => { });
    const dnsServers = await this._getDNSServers() || [];
    // redirect dns to vpn channel
    if (dnsServers.length > 0) {
      if (settings.routeDNS) {
        await vpnClientEnforcer.enforceDNSRedirect(this.getInterfaceName(), dnsServers, await this._getRemoteIP());
      } else {
        await vpnClientEnforcer.unenforceDNSRedirect(this.getInterfaceName(), dnsServers, await this._getRemoteIP());
      }
    }
    if (settings.overrideDefaultRoute) {
      const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
      if (rtId) {
        await VPNClient.ensureCreateEnforcementEnv(this.profileId);
        const rtIdHex = Number(rtId).toString(16);
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)}4 0.0.0.0/1`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)}4 128.0.0.0/1`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)}6 ::/1`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)}6 8000::/1`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getRouteIpsetName(this.profileId, false)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getRouteIpsetName(this.profileId, false)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      }
    } else {
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}4`).catch((err) => {});
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}6`).catch((err) => {});
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
    }
  }

  async _checkConnectivity() {
    if (!this._started || (this._lastStartTime && Date.now() - this._lastStartTime < 60000)) {
      return;
    }
    const result = await this._isLinkUp();
    if (result === false) {
      log.error(`VPN client ${this.profileId} is down.`);
      sem.emitEvent({
        type: "link_broken",
        profileId: this.profileId
      });
    } else {
      log.info(`VPN client ${this.profileId} is up.`);
      sem.emitEvent({
        type: "link_established",
        profileId: this.profileId
      });
    }
  }

  async getRoutedSubnets() {
    return null;
  }

  async _isLinkUp() {
    return true;
  }

  hookLinkStateChange() {
    sem.on('link_broken', async (event) => {
      if (this._started === true && this._currentState !== false && this.profileId === event.profileId) {
        // clear soft route ipset
        await VPNClient.ensureCreateEnforcementEnv(this.profileId);
        await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}4`).catch((err) => {});
        await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}6`).catch((err) => {});
        await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
        if (fc.isFeatureOn("vpn_disconnect")) {
          const Alarm = require('../../alarm/Alarm.js');
          const AlarmManager2 = require('../../alarm/AlarmManager2.js');
          const alarmManager2 = new AlarmManager2();
          const HostManager = require('../../net2/HostManager.js');
          const hostManager = new HostManager();
          const deviceCount = await hostManager.getVpnActiveDeviceCount(this.profileId);
          const alarm = new Alarm.VPNDisconnectAlarm(new Date() / 1000, null, {
            'p.vpn.profileid': this.profileId,
            'p.vpn.subtype': this.settings && this.settings.subtype,
            'p.vpn.devicecount': deviceCount,
            'p.vpn.displayname': (this.settings && (this.settings.displayName || this.settings.serverBoxName)) || this.profileId,
            'p.vpn.strictvpn': this.settings && this.settings.strictVPN || false
          });
          alarmManager2.enqueueAlarm(alarm);
        }
        this.scheduleRestart();
      }
      this._currentState = false;
    });

    sem.on('link_established', async (event) => {
      if (this._started === true && this._currentState === false && this.profileId === event.profileId) {
        // populate soft route ipset
        const settings = await this.loadSettings();
        if (settings.overrideDefaultRoute) {
          const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
          if (rtId) {
            await VPNClient.ensureCreateEnforcementEnv(this.profileId);
            const rtIdHex = Number(rtId).toString(16);
            await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)}4 0.0.0.0/1`).catch((err) => { });
            await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)}4 128.0.0.0/1`).catch((err) => { });
            await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)}6 ::/1`).catch((err) => { });
            await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)}6 8000::/1`).catch((err) => { });
            await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getRouteIpsetName(this.profileId, false)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
            await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getRouteIpsetName(this.profileId, false)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
          }
        } else {
          await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}4`).catch((err) => {});
          await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}6`).catch((err) => {});
          await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
        }
        if (fc.isFeatureOn("vpn_restore")) {
          const Alarm = require('../../alarm/Alarm.js');
          const AlarmManager2 = require('../../alarm/AlarmManager2.js');
          const alarmManager2 = new AlarmManager2();
          const HostManager = require('../../net2/HostManager.js');
          const hostManager = new HostManager();
          const deviceCount = await hostManager.getVpnActiveDeviceCount(this.profileId);
          const alarm = new Alarm.VPNRestoreAlarm(new Date() / 1000, null, {
            'p.vpn.profileid': this.profileId,
            'p.vpn.subtype': this.settings && this.settings.subtype,
            'p.vpn.devicecount': deviceCount,
            'p.vpn.displayname': (this.settings && (this.settings.displayName || this.settings.serverBoxName)) || this.profileId,
            'p.vpn.strictvpn': this.settings && this.settings.strictVPN || false
          });
          alarmManager2.enqueueAlarm(alarm);
        }
      }
      this._currentState = true;
    });
  }

  hookSettingsChange() {
    sem.on("VPNClient:SettingsChanged", async (event) => {
      const profileId = event.profileId;
      const settings = event.settings;
      if (profileId === this.profileId) {
        if (!this._isSettingsChanged(this.settings, settings))
          return;
        await this.loadSettings();
        if (this._started) {
          log.info(`Settings of VPN Client ${this.profileId} is changed, schedule restart ...`, this.settings);
          this.scheduleRestart();
        }
      }
    });

    sem.on("VPNClient:Stopped", async (event) => {
      const profileId = event.profileId;
      if (profileId === this.profileId)
        this._started = false;
    })
  }

  _isSettingsChanged(c1, c2) {
    const c1Copy = JSON.parse(JSON.stringify(c1));
    const c2Copy = JSON.parse(JSON.stringify(c2));
    for (const key of Object.keys(c1Copy)) {
      if (_.isArray(c1Copy[key]))
        c1Copy[key] = c1Copy[key].sort();
    }
    for (const key of Object.keys(c2Copy)) {
      if (_.isArray(c2Copy[key]))
        c2Copy[key] = c2Copy[key].sort();
    }
    return !_.isEqual(c1Copy, c2Copy);
  }

  scheduleRestart() {
    if (this.restartTask)
      clearTimeout(this.restartTask)
    this.restartTask = setTimeout(() => {
      if (!this._started)
        return;
      this.setup().then(() => this.start()).catch((err) => {
        log.error(`Failed to restart openvpn client ${this.profileId}`, err.message);
      });
    }, 5000);
  }

  _getSettingsPath() {

  }

  async _start() {

  }

  async _stop() {

  }

  async _getDNSServers() {
    return [];
  }

  // applicable to pointtopoint interfaces
  async _getRemoteIP() {
    return null;
  }

  async checkAndSaveProfile(value) {

  }

  async saveSettings(settings) {
    const settingsPath = this._getSettingsPath();
    let defaultSettings = {
      serverSubnets: [],
      overrideDefaultRoute: true,
      routeDNS: true,
      strictVPN: false
    }; // default settings
    const mergedSettings = Object.assign({}, defaultSettings, settings);
    this.settings = mergedSettings;
    await fs.writeFileAsync(settingsPath, JSON.stringify(mergedSettings), {encoding: 'utf8'});
    sem.emitEvent({
      type: "VPNClient:SettingsChanged",
      profileId: this.profileId,
      settings: this.settings,
      toProcess: "FireMain"
    });
  }

  async loadSettings() {
    const settingsPath = this._getSettingsPath();
    let settings = {
      serverSubnets: [],
      overrideDefaultRoute: true,
      routeDNS: true,
      strictVPN: false
    }; // default settings
    if (await fs.accessAsync(settingsPath, fs.constants.R_OK).then(() => {return true;}).catch(() => {return false;})) {
      const settingsContent = await fs.readFileAsync(settingsPath, {encoding: 'utf8'});
      settings = Object.assign({}, settings, JSON.parse(settingsContent));
    }
    this.settings = settings;
    return settings;
  }

  async setup() {
    const settings = await this.loadSettings();
    // check settings
    if (settings.serverSubnets && Array.isArray(settings.serverSubnets)) {
      for (let serverSubnet of settings.serverSubnets) {
        const ipSubnets = serverSubnet.split('/');
        if (ipSubnets.length != 2)
          throw `${serverSubnet} is not a valid CIDR subnet`;
        const ipAddr = ipSubnets[0];
        const maskLength = ipSubnets[1];
        // only check conflict of IPv4 addresses here
        if (!ipTool.isV4Format(ipAddr))
          continue;
        if (isNaN(maskLength) || !Number.isInteger(Number(maskLength)) || Number(maskLength) > 32 || Number(maskLength) < 0)
          throw `${serverSubnet} is not a valid CIDR subnet`;
        const serverSubnetCidr = ipTool.cidrSubnet(serverSubnet);
        for (const iface of sysManager.getLogicInterfaces()) {
          const mySubnetCidr = iface.subnet && ipTool.cidrSubnet(iface.subnet);
          if (!mySubnetCidr)
            continue;
          if (mySubnetCidr.contains(serverSubnetCidr.firstAddress) || serverSubnetCidr.contains(mySubnetCidr.firstAddress))
            throw `${serverSubnet} conflicts with subnet of ${iface.name} ${iface.subnet}`;
        }
      }
    }
  }

  async start() {
    this._started = true;
    this._lastStartTime = Date.now();
    // populate skbmark ipsets and enforce kill switch first
    
    const settings = await this.loadSettings();
    // vpn client route will not take effect if overrideDefaultRoute is not set
    if (settings.overrideDefaultRoute) {
      const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
      if (rtId) {
        await VPNClient.ensureCreateEnforcementEnv(this.profileId);
        const rtIdHex = Number(rtId).toString(16);
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)}4 0.0.0.0/1`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)}4 128.0.0.0/1`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)}6 ::/1`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)}6 8000::/1`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getRouteIpsetName(this.profileId)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getRouteIpsetName(this.profileId)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      }
    } else {
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}4`).catch((err) => {});
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}6`).catch((err) => {});
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => {});
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}4`).catch((err) => {});
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}6`).catch((err) => {});
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
    }
    if (settings.overrideDefaultRoute && settings.strictVPN) {
      await vpnClientEnforcer.enforceStrictVPN(this.getInterfaceName());
    } else {
      await vpnClientEnforcer.unenforceStrictVPN(this.getInterfaceName());
    }
    await this._start().catch((err) => {
      log.error(`Failed to exec _start of VPN client ${this.profileId}`, err.message);
    });
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const establishmentTask = setInterval(() => {
        (async () => {
          const isUp = await this._isLinkUp();
          if (isUp) {
            clearInterval(establishmentTask);
            await this._refreshRoutes();
            resolve(true);
          } else {
            const now = Date.now();
            if (now - startTime > 30000) {
              log.error(`Failed to establish tunnel for VPN client ${this.profileId} in 30 seconds`);
              clearInterval(establishmentTask);
              resolve(false);
            }
          }
        })().catch((err) => {
          log.error(`Failed to start VPN client ${this.profileId}`, err.message);
          clearInterval(establishmentTask);
          resolve(false);
        });
      }, 2000);
    });
  }

  async stop() {
    // flush routes before stop vpn client to ensure smooth switch of traffic routing
    const intf = this.getInterfaceName();
    this._started = false;
    await vpnClientEnforcer.flushVPNClientRoutes(intf);
    await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_POSTROUTING -o ${intf} -j MASQUERADE`)).catch((err) => {});
    await this.loadSettings();
    const dnsServers = await this._getDNSServers() || [];
    if (dnsServers.length > 0) {
      // always attempt to remove dns redirect rule, no matter whether 'routeDNS' in set in settings
      await vpnClientEnforcer.unenforceDNSRedirect(this.getInterfaceName(), dnsServers, await this._getRemoteIP());
    }
    await this._stop().catch((err) => {
      log.error(`Failed to exec _stop of VPN client ${this.profileId}`, err.message);
    });
    await vpnClientEnforcer.unenforceStrictVPN(this.getInterfaceName());
    await VPNClient.ensureCreateEnforcementEnv(this.profileId);
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}4`).catch((err) => {});
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}6`).catch((err) => {});
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}4`).catch((err) => {});
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}6`).catch((err) => {});
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
    
    sem.emitEvent({
      type: "VPNClient:Stopped",
      profileId: this.profileId,
      toProcess: "FireMain"
    });
  }

  async status() {

  }

  async getStatistics() {
    const status = await this.status();
    if (!status)
      return {};

    const intf = this.getInterfaceName();
    const rxBytes = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/rx_bytes`, 'utf8').then(r => Number(r.trim())).catch(() => 0);
    const txBytes = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/tx_bytes`, 'utf8').then(r => Number(r.trim())).catch(() => 0);
    return {bytesIn: rxBytes, bytesOut: txBytes};
  }

  async destroy() {
    await vpnClientEnforcer.destroyRtId(this.getInterfaceName());
  }

  getInterfaceName() {
    if (!this.profileId) {
      throw "profile id is not defined"
    }
    return `vpn_${this.profileId}`
  }

  static getRouteIpsetName(uid, hard = true) {
    if (uid) {
      return `c_rt_${hard ? "hard" : "soft"}_${uid.substring(0, 13)}_set`;
    } else
      return null;
  }

  static async ensureCreateEnforcementEnv(uid) {
    if (!uid)
      return;
    const hardRouteIpsetName = VPNClient.getRouteIpsetName(uid);
    const hardRouteIpsetName4 = `${hardRouteIpsetName}4`;
    const hardRouteIpsetName6 = `${hardRouteIpsetName}6`;
    await exec(`sudo ipset create -! ${hardRouteIpsetName} list:set skbinfo`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${hardRouteIpsetName}`, err.message);
    });
    await exec(`sudo ipset create -! ${hardRouteIpsetName4} hash:net maxelem 10`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${hardRouteIpsetName4}`, err.message);
    });
    await exec(`sudo ipset create -! ${hardRouteIpsetName6} hash:net family inet6 maxelem 10`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${hardRouteIpsetName6}`, err.message);
    });

    const softRouteIpsetName = VPNClient.getRouteIpsetName(uid, false);
    const softRouteIpsetName4 = `${softRouteIpsetName}4`;
    const softRouteIpsetName6 = `${softRouteIpsetName}6`;
    await exec(`sudo ipset create -! ${softRouteIpsetName} list:set skbinfo`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${softRouteIpsetName}`, err.message);
    });
    await exec(`sudo ipset create -! ${softRouteIpsetName4} hash:net maxelem 10`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${softRouteIpsetName4}`, err.message);
    });
    await exec(`sudo ipset create -! ${softRouteIpsetName6} hash:net family inet6 maxelem 10`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${softRouteIpsetName6}`, err.message);
    });
  }

  async profileExists() {
    const settingsPath = this._getSettingsPath();
    return fs.accessAsync(settingsPath, fs.constants.R_OK).then(() => true).catch(() => false);
  }

  static async listProfileIds() {
    return [];
  }

  async getAttributes(includeContent = false) {
    const settings = await this.loadSettings();
    const status = await this.status();
    const stats = await this.getStatistics();
    const profileId = this.profileId;
    return {profileId, settings, status, stats};
  }
}

module.exports = VPNClient;