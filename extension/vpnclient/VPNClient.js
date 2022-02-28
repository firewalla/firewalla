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
const ipset = require('../../net2/Ipset.js');
const PlatformLoader = require('../../platform/PlatformLoader.js')
const platform = PlatformLoader.getPlatform()

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
              this._scheduleRefreshRoutes();
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

  static getInstance(profileId) {
    if (instances.hasOwnProperty(profileId))
      return instances[profileId];
    else
      return null;
  }

  static async getVPNProfilesForInit(json) {
    const types = ["openvpn", "wireguard", "ssl", "zerotier", "trojan", "clash", "ipsec"];
    for (const type of types) {
      const c = this.getClass(type);
      if (c) {
        let profiles = [];
        const profileIds = await c.listProfileIds();
        Array.prototype.push.apply(profiles, await Promise.all(profileIds.map(profileId => new c({profileId: profileId}).getAttributes())));
        json[c.getKeyNameForInit()] = profiles;
      }
    }
  }

  static getClass(type) {
    if (!type) {
      throw new Error("type should be specified");
    }
    switch (type) {
      case "openvpn": {
        const c = require('./OpenVPNClient.js');
        return c;
        break;
      }
      case "wireguard": {
        const c = require('./WGVPNClient.js');
        return c;
        break;
      }
      case "ssl": {
        if (platform.isDockerSupported()) {
          const c = require('./docker/OCDockerClient.js');
          return c;
        } else {
          const c = require('./OCVPNClient.js');
          return c;
        }
        break;
      }
      //case "ssl": {
      //  const c = require('./OCVPNClient.js');
      //  return c;
      //  break;
      //}
      case "zerotier": {
        const c = require('./docker/ZTDockerClient.js');
        return c;
        break;
      }
      case "trojan": {
        const c = require('./docker/TrojanDockerClient.js');
        return c;
        break;
      }
      case "ipsec": {
        const c = require('./docker/IPSecDockerClient.js');
        return c;
        break;
      }
      case "clash": {
        const c = require('./docker/ClashDockerClient.js');
        return c;
        break;
      }
      default:
        log.error(`Unrecognized VPN client type: ${type}`);
        return null;
    }
  }

  _getRedisRouteUpMessageChannel() {
    return null;
  }

  static getProtocol() {
    return null;
  }

  static getKeyNameForInit() {
    return "";
  }

  async getVpnIP4s() {
    return null;
  }

  _scheduleRefreshRoutes() {
    if (this.refreshRoutesTask)
      clearTimeout(this.refreshRoutesTask);
    this.refreshRoutesTask = setTimeout(() => {
      this._refreshRoutes().catch((err) => {
        log.error(`Failed to refresh routes on VPN client ${this.profileId}`, err.message, err.stack);
      });
    }, 3000);
  }

  async _bypassDNSRedirect() {
    const chain = VPNClient.getDNSRedirectChainName(this.profileId);
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    const rtIdHex = rtId && Number(rtId).toString(16);
    await exec(`sudo iptables -w -t nat -F ${chain}`).catch((err) => {});
    await exec(`sudo ip6tables -w -t nat -F ${chain}`).catch((err) => {});

    const bins = ["iptables", "ip6tables"];

    for(const bin of bins) {
      const tcpCmd = iptables.wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p tcp --dport 53 -j ACCEPT`);
      await exec(tcpCmd).catch((err) => {
        log.error(`Failed to bypass DNS tcp53 redirect: ${cmd}, err:`, err.message);
      });
      const udpCmd = iptables.wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p udp --dport 53 -j ACCEPT`);
      await exec(udpCmd).catch((err) => {
        log.error(`Failed to bypass DNS udp53 redirect: ${cmd}, err:`, err.message);
      });
    }
  }

  async _updateDNSRedirectChain() {
    const dnsServers = await this._getDNSServers() || [];
    log.info("Updating dns redirect chain on servers:", dnsServers);

    const chain = VPNClient.getDNSRedirectChainName(this.profileId);
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    const rtIdHex = rtId && Number(rtId).toString(16);
    await exec(`sudo iptables -w -t nat -F ${chain}`).catch((err) => {});
    await exec(`sudo ip6tables -w -t nat -F ${chain}`).catch((err) => {});
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      let bin = "iptables";
      if (!ipTool.isV4Format(dnsServer) && ipTool.isV6Format(dnsServer)) {
        bin = "ip6tables";
      }
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = iptables.wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await exec(cmd).catch((err) => {
          log.error(`Failed to update DNS redirect chain: ${cmd}, dnsServer: ${dnsServer}`, err);
        });
        cmd = iptables.wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await exec(cmd).catch((err) => {
          log.error(`Failed to update DNS redirect chain: ${cmd}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = iptables.wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC}  -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await exec(cmd).catch((err) => {
          log.error(`Failed to update DNS redirect chain: ${cmd}, dnsServer: ${dnsServer}`, err);
        });
        cmd = iptables.wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC}  -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await exec(cmd).catch((err) => {
          log.error(`Failed to update DNS redirect chain: ${cmd}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
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
    log.info(`Refresh VPN client routes for ${this.profileId}, remote: ${remoteIP}, intf: ${intf}`);
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
    routedSubnets = this.getSubnetsWithoutConflict(_.uniq(routedSubnets));

    log.info(`Adding routes for vpn ${this.profileId}`, routedSubnets);

    await vpnClientEnforcer.enforceVPNClientRoutes(remoteIP, intf, routedSubnets, settings.overrideDefaultRoute == true);
    // loosen reverse path filter
    await exec(`sudo sysctl -w net.ipv4.conf.${intf}.rp_filter=2`).catch((err) => { });
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    const rtIdHex = rtId && Number(rtId).toString(16);
    await VPNClient.ensureCreateEnforcementEnv(this.profileId);

    if (settings.noDNSBooster === true) {
      await this._bypassDNSRedirect();
    } else {
      await this._updateDNSRedirectChain();
    }

    const dnsRedirectChain = VPNClient.getDNSRedirectChainName(this.profileId);
    const dnsServers = await this._getDNSServers() || [];
    // redirect dns to vpn channel
    if (settings.routeDNS) {
      if (rtId) {
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        if (!settings.strictVPN)
          await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      }
      if (dnsServers.length > 0)
        await vpnClientEnforcer.enforceDNSRedirect(this.getInterfaceName(), dnsServers, await this._getRemoteIP(), dnsRedirectChain);
    } else {
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => { });
      if (!settings.strictVPN)
        await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => { });
      if (dnsServers.length > 0)
        await vpnClientEnforcer.unenforceDNSRedirect(this.getInterfaceName(), dnsServers, await this._getRemoteIP(), dnsRedirectChain);
    }
    if (settings.overrideDefaultRoute) {
      if (rtId) {
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        if (!settings.strictVPN) {
          await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
          await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        }
      }
    } else {
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4}`).catch((err) => { });
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6}`).catch((err) => { });
      if (!settings.strictVPN) {
        await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4}`).catch((err) => { });
        await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6}`).catch((err) => { });
      }
    }
    const ip4s = await this.getVpnIP4s();
    await exec(`sudo ipset flush -! ${VPNClient.getSelfIpsetName(this.profileId, 4)}`).catch((err) => {});
    if (_.isArray(ip4s)) {
      for (const ip4 of ip4s) {
        await exec(`sudo ipset add -! ${VPNClient.getSelfIpsetName(this.profileId, 4)} ${ip4}`).catch((err) => {});
      }
    }
    if (settings.enablePortforward) {
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_EXT_IP -m set --match-set ${VPNClient.getSelfIpsetName(this.profileId, 4)} dst -i ${this.getInterfaceName()} -j FW_PREROUTING_PORT_FORWARD`)).catch((err) => {});
    } else {
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_EXT_IP -m set --match-set ${VPNClient.getSelfIpsetName(this.profileId, 4)} dst -i ${this.getInterfaceName()} -j FW_PREROUTING_PORT_FORWARD`)).catch((err) => {});
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
      if (this._started === true && this.profileId === event.profileId) {
        if (this._currentState !== false) {
          // clear soft route ipset
          await VPNClient.ensureCreateEnforcementEnv(this.profileId);
          await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
          // clear hard route ipset if strictVPN (kill-switch) is not enabled
          if (!this.settings.strictVPN)
            await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => {});
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
              'p.vpn.displayname': this.getDisplayName(),
              'p.vpn.strictvpn': this.settings && this.settings.strictVPN || false,
              'p.vpn.protocol': this.constructor.getProtocol()
            });
            alarmManager2.enqueueAlarm(alarm);
          }
        }
        this.scheduleRestart();
        this._currentState = false;
      }
    });

    sem.on('link_established', async (event) => {
      if (this._started === true && this._currentState === false && this.profileId === event.profileId) {
        // populate soft route ipset
        this._scheduleRefreshRoutes();
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
            'p.vpn.displayname': this.getDisplayName(),
            'p.vpn.strictvpn': this.settings && this.settings.strictVPN || false,
            'p.vpn.protocol': this.constructor.getProtocol()
          });
          alarmManager2.enqueueAlarm(alarm);
        }
        this._currentState = true;
      }
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
      // use _stop instead of stop() here, this will only re-establish connection, but will not remove other settings, e.g., kill-switch
      this.setup().then(() => this._stop()).then(() => this.start()).catch((err) => {
        log.error(`Failed to restart ${this.constructor.getProtocol()} vpn client ${this.profileId}`, err.message);
      });
    }, 5000);
  }

  getDisplayName() {
    return (this.settings && (this.settings.displayName || this.settings.serverBoxName)) || this.profileId;
  }

  // this is generic settings across different kinds of vpn clients
  _getSettingsPath() {
    return `${this.constructor.getConfigDirectory()}/${this.profileId}.settings`;
  }

  // this is dedicated configurations of different kinds of vpn clients
  _getJSONConfigPath() {
    return `${this.constructor.getConfigDirectory()}/${this.profileId}.json`;
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
    const protocol = this.constructor.getProtocol();
    const config = value && value.config || {};
    log.info(`vpn client [${protocol}][${this.profileId}] saving JSON config ...`);
    await this.saveJSONConfig(config);
  }

  async saveJSONConfig(config) {
    const configPath = this._getJSONConfigPath();
    await fs.writeFileAsync(configPath, JSON.stringify(config), {encoding: "utf8"});
  }

  async loadJSONConfig() {
    const configPath = this._getJSONConfigPath();
    return fs.readFileAsync(configPath, {encoding: "utf8"}).then(content => JSON.parse(content)).catch((err) => {
      log.error(`Failed to read JSON config of ${this.constructor.getProtocol()} vpn client ${this.profileId}`, err.message);
      return null;
    });
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

  getSubnetsWithoutConflict(subnets) {
    const validSubnets = [];
    if (subnets && Array.isArray(subnets)) {
      for (let subnet of subnets) {
        const ipSubnets = subnet.split('/');
        if (ipSubnets.length != 2) {
          continue;
        }
        const ipAddr = ipSubnets[0];
        const maskLength = ipSubnets[1];
        // only check conflict of IPv4 addresses here
        if (!ipTool.isV4Format(ipAddr))
          continue;
        if (isNaN(maskLength) || !Number.isInteger(Number(maskLength)) || Number(maskLength) > 32 || Number(maskLength) < 0) {
          continue;
        }
        const serverSubnetCidr = ipTool.cidrSubnet(subnet);
        const conflict = sysManager.getLogicInterfaces().some((iface) => {
          const mySubnetCidr = iface.subnet && ipTool.cidrSubnet(iface.subnet);
          return mySubnetCidr && (mySubnetCidr.contains(serverSubnetCidr.firstAddress) || serverSubnetCidr.contains(mySubnetCidr.firstAddress)) || false;
        });
        if (!conflict)
          validSubnets.push(subnet)
      }
    }
    return validSubnets;
  }

  async setup() {
    const settings = await this.loadSettings();
    // check settings
    if (settings.serverSubnets && Array.isArray(settings.serverSubnets)) {
      for (let serverSubnet of settings.serverSubnets) {
        const ipSubnets = serverSubnet.split('/');
        if (ipSubnets.length != 2)
          throw new Error(`${serverSubnet} is not a valid CIDR subnet`);
        const ipAddr = ipSubnets[0];
        const maskLength = ipSubnets[1];
        // only check conflict of IPv4 addresses here
        if (!ipTool.isV4Format(ipAddr))
          continue;
        if (isNaN(maskLength) || !Number.isInteger(Number(maskLength)) || Number(maskLength) > 32 || Number(maskLength) < 0)
          throw new Error(`${serverSubnet} is not a valid CIDR subnet`);
        const serverSubnetCidr = ipTool.cidrSubnet(serverSubnet);
        for (const iface of sysManager.getLogicInterfaces()) {
          const mySubnetCidr = iface.subnet && ipTool.cidrSubnet(iface.subnet);
          if (!mySubnetCidr)
            continue;
          if (mySubnetCidr.contains(serverSubnetCidr.firstAddress) || serverSubnetCidr.contains(mySubnetCidr.firstAddress))
            log.error(`${serverSubnet} conflicts with subnet of ${iface.name} ${iface.subnet}`);
        }
      }
    }
  }

  async start() {
    this._started = true;
    this._lastStartTime = Date.now();
    // populate skbmark ipsets and enforce kill switch first
    
    const settings = await this.loadSettings();
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    const rtIdHex = rtId && Number(rtId).toString(16);
    await VPNClient.ensureCreateEnforcementEnv(this.profileId);
    // vpn client route will not take effect if overrideDefaultRoute is not set
    // do not need to populate route ipset if strictVPN (kill-switch) is not enabled, it will be populated after link is established
    if (settings.overrideDefaultRoute && settings.strictVPN) {
      if (rtId) {
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      }
      await vpnClientEnforcer.enforceStrictVPN(this.getInterfaceName());
    } else {
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => {});
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
      await vpnClientEnforcer.unenforceStrictVPN(this.getInterfaceName());
    }
    if (settings.routeDNS && settings.strictVPN) {
      if (rtId) {
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
      }
    } else {
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => {});
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => {});
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
            this._scheduleRefreshRoutes();
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
    await VPNClient.ensureCreateEnforcementEnv(this.profileId);
    await vpnClientEnforcer.flushVPNClientRoutes(intf);
    await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_POSTROUTING -o ${intf} -j MASQUERADE`)).catch((err) => {});
    await this.loadSettings();
    const dnsServers = await this._getDNSServers() || [];
    if (dnsServers.length > 0) {
      // always attempt to remove dns redirect rule, no matter whether 'routeDNS' in set in settings
      await vpnClientEnforcer.unenforceDNSRedirect(this.getInterfaceName(), dnsServers, await this._getRemoteIP(), VPNClient.getDNSRedirectChainName(this.profileId));
    }
    await this._stop().catch((err) => {
      log.error(`Failed to exec _stop of VPN client ${this.profileId}`, err.message);
    });
    await vpnClientEnforcer.unenforceStrictVPN(this.getInterfaceName());
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${VPNClient.getSelfIpsetName(this.profileId, 4)}`).catch((err) => {});
    await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_EXT_IP -m set --match-set ${VPNClient.getSelfIpsetName(this.profileId, 4)} dst -i ${this.getInterfaceName()} -j FW_PREROUTING_PORT_FORWARD`)).catch((err) => {});
    
    if (!f.isMain()) {
      sem.emitEvent({
        type: "VPNClient:Stopped",
        profileId: this.profileId,
        toProcess: "FireMain"
      });
    }
  }

  async status() {
    return this._isLinkUp();
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
    await fs.unlinkAsync(this._getSettingsPath()).catch((err) => {});
    await fs.unlinkAsync(this._getJSONConfigPath()).catch((err) => {});
    delete instances[this.profileId];
  }

  getInterfaceName() {
    if (!this.profileId) {
      throw new Error("profile id is not defined");
    }
    return `vpn_${this.profileId}`
  }

  static getRouteIpsetName(uid, hard = true) {
    if (uid) {
      return `c_rt_${hard ? "hard" : "soft"}_${uid.substring(0, 13)}_set`;
    } else
      return null;
  }

  static getSelfIpsetName(uid, af = 4) {
    if (uid) {
      return `c_ip_${uid.substring(0, 13)}_set${af}`;
    } else
      return null;
  }

  static getDNSRedirectChainName(uid) {
    return `FW_PR_VC_DNS_${uid.substring(0, 13)}`;
  }

  static async ensureCreateEnforcementEnv(uid) {
    if (!uid)
      return;
    const hardRouteIpsetName = VPNClient.getRouteIpsetName(uid);
    await exec(`sudo ipset create -! ${hardRouteIpsetName} list:set skbinfo`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${hardRouteIpsetName}`, err.message);
    });

    const softRouteIpsetName = VPNClient.getRouteIpsetName(uid, false);
    await exec(`sudo ipset create -! ${softRouteIpsetName} list:set skbinfo`).catch((err) => {
      log.error(`Failed to create vpn client routing ipset ${softRouteIpsetName}`, err.message);
    });

    const selfIpsetName = VPNClient.getSelfIpsetName(uid, 4);
    await exec(`sudo ipset create -! ${selfIpsetName} hash:ip family inet`).catch((err) => {
      log.error(`Failed to create vpn client self IPv4 ipset ${selfIpsetName}`, err.message);
    });

    const dnsRedirectChain = VPNClient.getDNSRedirectChainName(uid);
    await exec(`sudo iptables -w -t nat -N ${dnsRedirectChain} &>/dev/null || true`).catch((err) => {
      log.error(`Failed to create vpn client DNS redirect chain ${dnsRedirectChain}`, err.message);
    });
    await exec(`sudo ip6tables -w -t nat -N ${dnsRedirectChain} &>/dev/null || true`).catch((err) => {
      log.error(`Failed to create ipv6 vpn client DNS redirect chain ${dnsRedirectChain}`, err.message);
    });
  }

  static async profileExists(profileId) {
    const profileIds = await this.listProfileIds();
    return profileIds && profileIds.includes(profileId);
  }

  static getConfigDirectory() {

  }

  static async listProfileIds() {
    const dirPath = this.getConfigDirectory();
    const files = await fs.readdirAsync(dirPath).catch(() => []);
    const profileIds = files.filter(filename => filename.endsWith('.settings')).map(filename => filename.slice(0, filename.length - ".settings".length));
    return profileIds;
  }

  // a generic api to get verbose status/error message from vpn client
  async getMessage() {
    return "";
  }

  async getAttributes(includeContent = false) {
    const settings = await this.loadSettings();
    const status = await this.status();
    const stats = await this.getStatistics();
    const message = await this.getMessage();
    const profileId = this.profileId;
    let routedSubnets = settings.serverSubnets || [];
    // add vpn client specific routes
    try {
      const vpnSubnets = await this.getRoutedSubnets();
      if (vpnSubnets && _.isArray(vpnSubnets))
        routedSubnets = routedSubnets.concat(vpnSubnets);
    } catch (err) {
      log.error('Failed to parse VPN subnet', err.message);
    }
    routedSubnets = this.getSubnetsWithoutConflict(_.uniq(routedSubnets));

    const config = await this.loadJSONConfig() || {};
    const remoteIP = await this._getRemoteIP();
    const type = await this.constructor.getProtocol();
    return {profileId, settings, status, stats, message, routedSubnets, type, config, remoteIP};
  }

  async resolveFirewallaDDNS(domain) {
    if (!domain.endsWith("firewalla.org") && !domain.endsWith("firewalla.com"))
      return;
    // first, find DNS zone from AUTHORITY SECTION
    const zone = await exec(`dig +time=3 +tries=2 SOA ${domain} | grep ";; AUTHORITY SECTION" -A 1 | tail -n 1 | awk '{print $1}'`).then(result => result.stdout.trim()).catch((err) => {
      log.error(`Failed to find zone of ${domain}`, err.message);
      return null;
    });
    if (!zone)
      return;
    // then, find authoritative DNS server on zone
    const servers = await exec(`dig +time=3 +tries=2 +short NS ${zone}`).then(result => result.stdout.trim().split('\n').filter(line => !line.startsWith(";;"))).catch((err) => {
      log.error(`Failed to get servers of zone ${zone}`, err.message);
      return [];
    });
    // finally, send DNS query to authoritative DNS server
    for (const server of servers) {
      const ip = await exec(`dig +short +time=3 +tries=1 @${server} A ${domain}`).then(result => result.stdout.trim().split('\n').find(line => new Address4(line).isValid())).catch((err) => {
        log.error(`Failed to resolve ${domain} using ${server}`, err.message);
        return null;
      });
      if (ip)
        return ip;
    }
    return null;
  }
}

module.exports = VPNClient;
