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
const { Address4, Address6 } = require('ip-address');
const sysManager = require('../../net2/SysManager');
const ipTool = require('ip');
const ipset = require('../../net2/Ipset.js');
const PlatformLoader = require('../../platform/PlatformLoader.js');
const { rclient } = require('../../util/redis_manager.js');
const Constants = require('../../net2/Constants.js');
const AsyncLock = require('../../vendor_lib/async-lock');
const lock = new AsyncLock();
const platform = PlatformLoader.getPlatform()
const envCreatedMap = {};
const INTERNET_ON_OFF_THRESHOLD = 2;

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
        this.internetFailureCount = 0;
        this.internetSuccessCount = 0;
        this.hookLinkStateChange();
        this.hookSettingsChange();

        setInterval(() => {
          this._checkConnectivity().catch((err) => {
            log.error(`Failed to check connectivity on VPN client ${this.profileId}`, err.message);
          });
        }, 30000);

        if (this._getRedisRouteUpdateMessageChannel()) {
          const channel = this._getRedisRouteUpdateMessageChannel();
          sclient.on("message", (c, message) => {
            if (c === channel && message === this.profileId) {
              log.info(`VPN client ${this.profileId} route is updated, will refresh routes ...`);
              this._scheduleRefreshRoutes();
              // emit link established event immediately
              if (this._started) {
                sem.emitEvent({
                  type: "link_established",
                  profileId: this.profileId,
                  routeUpdated: true,
                  suppressEventLogging: true,
                });
              }
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

  static async getVPNProfilesForInit() {
    const types = ["openvpn", "wireguard", "ssl", "zerotier", "nebula", "trojan", "clash", "hysteria", "gost", "ipsec", "ts"];
    const results = {}
    await Promise.all(types.map(async (type) => {
      const c = this.getClass(type);
      if (c) {
        let profiles = [];
        const profileIds = await c.listProfileIds();
        Array.prototype.push.apply(profiles, await Promise.all(profileIds.map(profileId => new c({ profileId: profileId }).getAttributes())));
        results[c.getKeyNameForInit()] = profiles;
      }
    }));
    return results
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
      case "nebula": {
        const c = require('./docker/NebulaDockerClient.js');
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
      case "hysteria": {
        const c = require('./docker/HysteriaDockerClient.js');
        return c;
        break;
      }
      case "gost": {
        const c = require('./docker/GostDockerClient.js');
        return c;
        break;
      }
      case "ts": {
        const c = require('./docker/TSDockerClient.js');
        return c;
        break;
      }
      default:
        throw new Error(`Unrecognized VPN client type: ${type}`);
        return null;
    }
  }

  _getRedisRouteUpdateMessageChannel() {
    return null;
  }

  static getProtocol() {
    return null;
  }

  static getKeyNameForInit() {
    return "";
  }

  static getDnsMarkTag(profileId) {
    return `vc_${profileId}`;
  }

  async getVpnIP4s() {
    return null;
  }

  async getVpnIP6s() {
    return null;
  }

  _getDnsmasqConfigPath() {
    return `${f.getUserConfigFolder()}/dnsmasq/vc_${this.profileId}.conf`;
  }

  _getDnsmasqRouteConfigPath(routeType = "hard") {
    return `${f.getUserConfigFolder()}/dnsmasq/vc_${this.profileId}_${routeType}.conf`;
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
    await exec(`sudo iptables -w -t nat -F ${chain}`).catch((err) => { });
    await exec(`sudo ip6tables -w -t nat -F ${chain}`).catch((err) => { });

    const bins = ["iptables", "ip6tables"];

    for (const bin of bins) {
      const tcpCmd = iptables.wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p tcp --dport 53 -j ACCEPT`);
      await exec(tcpCmd).catch((err) => {
        log.error(`Failed to bypass DNS tcp53 redirect: ${tcpCmd}, err:`, err.message);
      });
      const udpCmd = iptables.wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p udp --dport 53 -j ACCEPT`);
      await exec(udpCmd).catch((err) => {
        log.error(`Failed to bypass DNS udp53 redirect: ${tcpCmd}, err:`, err.message);
      });
    }
  }

  async _updateDNSRedirectChain() {
    const dnsServers = await this._getDNSServers() || [];
    log.verbose("Updating dns redirect chain on servers:", dnsServers);

    const chain = VPNClient.getDNSRedirectChainName(this.profileId);
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    const rtIdHex = rtId && Number(rtId).toString(16);
    await exec(`sudo iptables -w -t nat -F ${chain}`).catch((err) => { });
    await exec(`sudo ip6tables -w -t nat -F ${chain}`).catch((err) => { });
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      if (dnsServer == '') {
        continue
      }
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

  async isSNATNeeded() {
    return true;
  }

  async _refreshRoutes() {
    if (!this._started)
      return;
    const settings = await this.loadSettings();
    const isUp = await this._isLinkUp();
    if (!isUp) {
      if (!settings.strictVPN) {
        await this._resetRouteMarkInRedis();
      }
      log.error(`VPN client ${this.profileId} is not up, skip refreshing routes`);
      return;
    }
    const remoteIP = await this._getRemoteIP();
    const remoteIP6 = await this._getRemoteIP6();
    const localIP6 = await this._getLocalIP6();
    const intf = this.getInterfaceName();
    const snatNeeded = await this.isSNATNeeded();
    if (settings.c2sSNATDisabled) {
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -I FW_VC_SNAT -m set --match-set ${VPNClient.getNetIpsetName(this.profileId, 4)}4 dst -j RETURN`)).catch((err) => { });
      await exec(iptables.wrapIptables(`sudo ip6tables -w -t nat -I FW_VC_SNAT -m set --match-set ${VPNClient.getNetIpsetName(this.profileId, 6)}6 dst -j RETURN`)).catch((err) => { });
    } else {
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_VC_SNAT -m set --match-set ${VPNClient.getNetIpsetName(this.profileId, 4)}4 dst -j RETURN`)).catch((err) => { });
      await exec(iptables.wrapIptables(`sudo ip6tables -w -t nat -D FW_VC_SNAT -m set --match-set ${VPNClient.getNetIpsetName(this.profileId, 6)}6 dst -j RETURN`)).catch((err) => { });
    }
    if (snatNeeded) {
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -A FW_VC_SNAT -o ${intf} -j MASQUERADE`)).catch((err) => { });
      await exec(iptables.wrapIptables(`sudo ip6tables -w -t nat -A FW_VC_SNAT -o ${intf} -j MASQUERADE`)).catch((err) => { });
    }
    log.verbose(`Refresh VPN client routes for ${this.profileId}, remote: ${remoteIP}, intf: ${intf}`);
    // remove routes from main table which is inserted by VPN client automatically,
    // otherwise tunnel will be enabled globally
    await routing.removeRouteFromTable("0.0.0.0/1", remoteIP, intf, "main").catch((err) => { log.verbose("No need to remove 0.0.0.0/1 for " + this.profileId) });
    await routing.removeRouteFromTable("128.0.0.0/1", remoteIP, intf, "main").catch((err) => { log.verbose("No need to remove 128.0.0.0/1 for " + this.profileId) });
    await routing.removeRouteFromTable("default", remoteIP, intf, "main").catch((err) => { log.verbose("No need to remove default route for " + this.profileId) });
    if (localIP6)
      await routing.removeRouteFromTable("default", remoteIP, intf, "main", null, 6).catch((err) => { log.verbose("No need to remove IPv6 default route for " + this.profileId) });
    const routedSubnets = await this.getEffectiveRoutedSubnets();
    const dnsServers = await this._getDNSServers() || [];

    if (routedSubnets.length)
      log.info(`Adding routes for vpn ${this.profileId}`, routedSubnets);
    // always add default route into VPN client's routing table, the switch is implemented in ipset, so no need to implement it in routing tables
    await vpnClientEnforcer.enforceVPNClientRoutes(remoteIP, remoteIP6, intf, routedSubnets, dnsServers, true, Boolean(localIP6));
    // loosen reverse path filter
    await exec(`sudo sysctl -w net.ipv4.conf.${intf}.rp_filter=2`).catch((err) => { });
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    const rtIdHex = rtId && Number(rtId).toString(16);
    await VPNClient.ensureCreateEnforcementEnv(this.profileId);

    await this._setRouteMarkInRedis();

    if (settings.noDNSBooster === true) {
      await this._bypassDNSRedirect();
    } else {
      await this._updateDNSRedirectChain();
    }

    const DNSMASQ = require('../dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    const dnsRedirectChain = VPNClient.getDNSRedirectChainName(this.profileId);
    // enforce vpn client config in dnsmasq
    const dnsmasqEntries = [`mark=${rtId}$${VPNClient.getDnsMarkTag(this.profileId)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`];
    if (dnsServers.length > 0)
      dnsmasqEntries.push(`server=${dnsServers[0]}$${VPNClient.getDnsMarkTag(this.profileId)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`);
    await fs.writeFileAsync(this._getDnsmasqConfigPath(), dnsmasqEntries.join('\n')).catch((err) => { });
    // redirect dns to vpn channel
    if (settings.routeDNS) {
      if (rtId) {
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        await this._enableDNSRoute("soft");
        if (!settings.strictVPN) {
          await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
          await this._enableDNSRoute("hard");
        }
      }
      if (dnsServers.length > 0) {
        await vpnClientEnforcer.enforceDNSRedirect(this.getInterfaceName(), dnsServers, dnsRedirectChain);
      }
      dnsmasq.scheduleRestartDNSService();
    } else {
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => { });
      if (!settings.strictVPN)
        await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => { });
      if (dnsServers.length > 0)
        await vpnClientEnforcer.unenforceDNSRedirect(this.getInterfaceName(), dnsServers, dnsRedirectChain);
      await this._disableDNSRoute("hard");
      await this._disableDNSRoute("soft");
      dnsmasq.scheduleRestartDNSService();
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
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4}`).catch((err) => { });
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6}`).catch((err) => { });
    }

    if (rtId) {
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getNetIpsetName(this.profileId)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getNetIpsetName(this.profileId)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getNetIpsetName(this.profileId)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getNetIpsetName(this.profileId)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
    }
    await exec(`sudo ipset flush -! ${VPNClient.getNetIpsetName(this.profileId)}4`).catch((err) => { });
    await exec(`sudo ipset flush -! ${VPNClient.getNetIpsetName(this.profileId)}6`).catch((err) => { });
    for (const routedSubnet of routedSubnets) {
      await exec(`sudo ipset add -! ${VPNClient.getNetIpsetName(this.profileId)}${new Address4(routedSubnet).isValid() ? "4" : "6"} ${routedSubnet}`).catch((err) => { });
    }
    const ip4s = await this.getVpnIP4s();
    await exec(`sudo ipset flush -! ${VPNClient.getSelfIpsetName(this.profileId, 4)}`).catch((err) => { });
    if (_.isArray(ip4s)) {
      for (const ip4 of ip4s) {
        await exec(`sudo ipset add -! ${VPNClient.getSelfIpsetName(this.profileId, 4)} ${ip4}`).catch((err) => { });
      }
    }
    // port forward on VPN client will be enabled by default, the port forward rule will decide if it takes effect on specific VPN client
    if (!settings.hasOwnProperty("enablePortforward") || settings.enablePortforward) {
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_VC_EXT_IP -m set --match-set ${VPNClient.getSelfIpsetName(this.profileId, 4)} dst -i ${this.getInterfaceName()} -j FW_PRERT_VC_PORT_FORWARD`)).catch((err) => { });
    } else {
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_VC_EXT_IP -m set --match-set ${VPNClient.getSelfIpsetName(this.profileId, 4)} dst -i ${this.getInterfaceName()} -j FW_PRERT_VC_PORT_FORWARD`)).catch((err) => { });
    }
  }

  async _checkConnectivity(force = false) {
    if (!this._started || this._restarting || (this._lastStartTime && Date.now() - this._lastStartTime < 60000 && !force)) {
      if (!this._started) {
        await this._setCachedState(false);
      }
      return;
    }
    let result = await this._isLinkUp();
    if (result === false) {
      log.error(`VPN client ${this.profileId} underlying link is down.`);
    } else {
      log.debug(`VPN client ${this.profileId} underlying link is up.`);
      if (this.settings.overrideDefaultRoute) {
        const internetAvailability = await this._isInternetAvailable();
        if (!internetAvailability) {
          log.error(`Internet is unavailable via VPN client ${this.profileId}`);
          this.internetFailureCount++;
          this.internetSuccessCount = 0;
        } else {
          log.debug(`Internet is available via VPN client ${this.profileId}`);
          this.internetFailureCount = 0;
          this.internetSuccessCount++;
        }
        // update result if consecutive internet connectivity tests return same results
        if (this.internetSuccessCount >= INTERNET_ON_OFF_THRESHOLD)
          result = true;
        else {
          if (this.internetFailureCount >= INTERNET_ON_OFF_THRESHOLD)
            result = false;
          else // internet success/failure count is within switching threshold, pending another consecutive result to decide
            result = null;
        }
      }
    }
    if (this._restarting)
      return;
    // result is null means internet connectivity is still pending another consecutive result to decide, do not emit event in this round
    if (result === null)
      return;
    if (result) {
      await this._setCachedState(true);
      sem.emitEvent({
        type: "link_established",
        profileId: this.profileId,
        routeUpdated: force,
        suppressEventLogging: true,
      });
    } else {
      await this._setCachedState(false);
      sem.emitEvent({
        type: "link_broken",
        profileId: this.profileId,
        suppressEventLogging: true,
      });
    }
  }

  async getEffectiveRoutedSubnets() {
    const settings = await this.loadSettings();
    const subnets = {};
    const serverSubnets = _.get(settings, "serverSubnets");
    if (!_.isEmpty(serverSubnets)) {
      for (const s of serverSubnets) {
        let addr = new Address4(s);
        if (!addr.isValid()) {
          addr = new Address6(s);
          if (!addr.isValid())
            continue;
        }
        // convert to network address and subnet mask length, it is required before being added to routing table
        subnets[`${addr.startAddress().correctForm()}/${addr.subnetMask}`] = 1;
      }
    }
    const routedSubnets = await this.getRoutedSubnets();
    if (!_.isEmpty(routedSubnets)) {
      for (const s of routedSubnets) {
        subnets[s] = 1;
      }
    }
    return this.getSubnetsWithoutConflict(Object.keys(subnets));
  }

  async getRoutedSubnets() {
    return null;
  }

  async _isLinkUp() {
    return true;
  }

  async _autoReconnectNeeded() {
    if (this.settings && this.settings.hasOwnProperty("autoReconnect"))
      return this.settings.autoReconnect;
    return true;
  }

  hookLinkStateChange() {
    sem.on('link_broken', async (event) => {
      if (this._started === true && this.profileId === event.profileId) {
        if (this._currentState !== false) {
          // clear soft route ipset
          await VPNClient.ensureCreateEnforcementEnv(this.profileId);
          await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => { });
          await this._disableDNSRoute("soft");
          // clear hard route ipset if strictVPN (kill-switch) is not enabled
          if (!this.settings.strictVPN) {
            await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => { });
            await this._disableDNSRoute("hard");
            await this._resetRouteMarkInRedis();
          }
          if (fc.isFeatureOn(Constants.FEATURE_VPN_DISCONNECT)) {
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
              'p.vpn.overrideDefaultRoute': this.settings && this.settings.overrideDefaultRoute,
              'p.vpn.strictvpn': this.settings && this.settings.strictVPN || false,
              'p.vpn.protocol': this.constructor.getProtocol()
            });
            alarmManager2.enqueueAlarm(alarm);
          }
        }
        const autoReconnectNeeded = await this._autoReconnectNeeded();
        if (autoReconnectNeeded)
          this.scheduleRestart();
        this._currentState = false;
      }
    });

    sem.on('link_established', async (event) => {
      if (this._started === true && this._currentState === false && this.profileId === event.profileId) {
        // populate soft route ipset
        this._scheduleRefreshRoutes();
        if (fc.isFeatureOn(Constants.FEATURE_VPN_RESTORE)) {
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
            'p.vpn.overrideDefaultRoute': this.settings && this.settings.overrideDefaultRoute,
            'p.vpn.strictvpn': this.settings && this.settings.strictVPN || false,
            'p.vpn.protocol': this.constructor.getProtocol()
          });
          alarmManager2.enqueueAlarm(alarm);
        }
        this._currentState = true;
      }
    });

    sem.on('link_wan_switched', async (event) => {
      if (this._started === true && this.profileId === event.profileId) {
        if (this._currentState !== false) {
          // clear soft route ipset
          await VPNClient.ensureCreateEnforcementEnv(this.profileId);
          await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => { });
          await this._disableDNSRoute("soft");
          // clear hard route ipset if strictVPN (kill-switch) is not enabled
          if (!this.settings.strictVPN) {
            await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => { });
            await this._disableDNSRoute("hard");
            await this._resetRouteMarkInRedis();
          }
        }
        this.scheduleRestart();
        this._currentState = false;
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
          log.info(`Settings of VPN Client ${this.profileId} is changed, schedule prepare and refresh routes ...`, this.settings);
          await this._prepareRoutes();
          this._scheduleRefreshRoutes();
        }
      }
    });

    sem.on("VPNClient:Stopped", async (event) => {
      const profileId = event.profileId;
      if (profileId === this.profileId)
        this._started = false;
    })

    sem.on("VPNClient:Started", async (event) => {
      const profileId = event.profileId;
      if (profileId === this.profileId)
        this._started = true;
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
      this._restarting = true;
      this.setup().then(() => this._stop()).then(() => this.start()).catch((err) => {
        log.error(`Failed to restart ${this.constructor.getProtocol()} vpn client ${this.profileId}`, err.message);
      }).finally(() => {
        this._restarting = false;
      });
    }, 5000);
  }

  getDisplayName() {
    return (this.settings && (this.settings.displayName || this.settings.serverBoxName)) || this.profileId;
  }

  getFwMark() {
    if (this.settings && this.settings.wanUUID) {
      const intf = sysManager.getWanInterfaces().find(iface => iface && iface.uuid === this.settings.wanUUID);
      if (intf) {
        return intf.rtid;
      }
    }
    return null;
  }

  getWanInterface() {
    if (this.settings && this.settings.wanUUID) {
      const intf = sysManager.getWanInterfaces().find(iface => iface && iface.uuid === this.settings.wanUUID);
      if (intf) {
        return intf;
      }
    }
    return sysManager.getDefaultWanInterface();
  }

  async getRemoteEndpoints() {
    return [];
  }

  async addRemoteEndpointRoutes() {
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    const remoteEndpoints = await this.getRemoteEndpoints();
    const routes = [];
    if (_.isArray(remoteEndpoints) && !_.isEmpty(remoteEndpoints)) {
      for (const endpoint of remoteEndpoints) {
        if (endpoint.ip && new Address4(endpoint.ip).isValid()) {
          const wanIntf = this.getWanInterface();
          await routing.addRouteToTable(endpoint.ip, wanIntf && wanIntf.gateway, wanIntf && wanIntf.name, "main", rtId, 4).catch((err) => { });
          routes.push({ ip: endpoint.ip, gw: wanIntf && wanIntf.gateway, dev: wanIntf && wanIntf.name, pref: rtId });
        }
      }
      await fs.writeFileAsync(this._getEndpointRoutesPath(), JSON.stringify(routes), { encoding: "utf8" }).catch((err) => { }); // save remote endpoints to file to guarantee it survives over the service restart
    }
  }

  async flushRemoteEndpointRoutes() {
    const routes = await fs.readFileAsync(this._getEndpointRoutesPath(), { encoding: "utf8" }).then((content) => JSON.parse(content)).catch((err) => null);
    if (_.isArray(routes) && !_.isEmpty(routes)) {
      for (const route of routes) {
        await routing.removeRouteFromTable(route.ip, route.gw, route.dev, "main", route.pref, 4).catch((err) => { });
      }
    }
    await fs.unlinkAsync(this._getEndpointRoutesPath()).catch((err) => { });
  }

  _getEndpointRoutesPath() {
    return `${this.constructor.getConfigDirectory()}/${this.profileId}.endpoint_routes`;
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

  async _getRemoteIP6() {
    return null;
  }

  async _getLocalIP() {
    const intf = this.getInterfaceName();
    return exec(`ip addr show dev ${intf} | awk '/inet /' | awk '{print $2}' | head -n 1`).then(result => result.stdout.trim().split('/')[0]).catch((err) => null);
  }

  async _getLocalIP6() {
    const intf = this.getInterfaceName();
    return exec(`ip addr show dev ${intf} | awk '/inet6 /' | awk '{print $2}' | head -n 1`).then(result => result.stdout.trim().split('/')[0]).catch((err) => null);
  }

  async checkAndSaveProfile(value) {
    const protocol = this.constructor.getProtocol();
    const config = value && value.config || {};
    log.info(`vpn client [${protocol}][${this.profileId}] saving JSON config ...`);
    await this.saveJSONConfig(config);
  }

  async saveJSONConfig(config) {
    const configPath = this._getJSONConfigPath();
    await fs.writeFileAsync(configPath, JSON.stringify(config), { encoding: "utf8" });
  }

  async loadJSONConfig() {
    const configPath = this._getJSONConfigPath();
    return fs.readFileAsync(configPath, { encoding: "utf8" }).then(content => JSON.parse(content)).catch((err) => {
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
      c2sSNATDisabled: false,
      strictVPN: false
    }; // default settings
    const mergedSettings = Object.assign({}, defaultSettings, settings);
    this.settings = mergedSettings;
    await fs.writeFileAsync(settingsPath, JSON.stringify(mergedSettings), { encoding: 'utf8' });
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
      c2sSNATDisabled: false,
      routeDNS: true,
      strictVPN: false
    }; // default settings
    if (await fs.accessAsync(settingsPath, fs.constants.R_OK).then(() => { return true; }).catch(() => { return false; })) {
      const settingsContent = await fs.readFileAsync(settingsPath, { encoding: 'utf8' });
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

  static getDNSRouteConfDir(profileId, routeType = "hard") {
    return `${f.getUserConfigFolder()}/dnsmasq/VC:${profileId}_${routeType}`;
  }

  async _enableDNSRoute(routeType = "hard") {
    const DNSMASQ = require('../dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    await fs.writeFileAsync(this._getDnsmasqRouteConfigPath(routeType), `conf-dir=${VPNClient.getDNSRouteConfDir(this.profileId, routeType)}`).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  async _disableDNSRoute(routeType = "hard") {
    const DNSMASQ = require('../dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    await fs.unlinkAsync(this._getDnsmasqRouteConfigPath(routeType)).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
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

  async _prepareRoutes() {
    // populate skbmark ipsets and enforce kill switch first
    const settings = await this.loadSettings();
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    const rtIdHex = rtId && Number(rtId).toString(16);
    await VPNClient.ensureCreateEnforcementEnv(this.profileId);
    const oifIpsetName = VPNClient.getOifIpsetName(this.profileId);
    const oifIpsetName4 = `${oifIpsetName}4`;
    const oifIpsetName6 = `${oifIpsetName}6`;
    await exec(`sudo ipset add -! ${oifIpsetName4} 0.0.0.0/1,${this.getInterfaceName()}`).catch((err) => { });
    await exec(`sudo ipset add -! ${oifIpsetName4} 128.0.0.0/1,${this.getInterfaceName()}`).catch((err) => { });
    await exec(`sudo ipset add -! ${oifIpsetName6} ::/1,${this.getInterfaceName()}`).catch((err) => { });
    await exec(`sudo ipset add -! ${oifIpsetName6} 8000::/1,${this.getInterfaceName()}`).catch((err) => { });
    // do not need to populate route ipset if strictVPN (kill-switch) is not enabled, it will be populated after link is established
    if (settings.strictVPN) {
      if (settings.overrideDefaultRoute && rtId) {
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      } else {
        await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => { });
        await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => { });
      }
      await vpnClientEnforcer.enforceStrictVPN(this.getInterfaceName());
      await this._setRouteMarkInRedis();
    } else {
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => { });
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => { });
      await vpnClientEnforcer.unenforceStrictVPN(this.getInterfaceName());
      await this._resetRouteMarkInRedis();
    }
    const dnsServers = await this._getDNSServers() || [];
    const DNSMASQ = require('../dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    const dnsmasqEntries = [`mark=${rtId}$${VPNClient.getDnsMarkTag(this.profileId)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`];
    if (_.isEmpty(dnsServers)) {
      dnsmasqEntries.push(`server=//$${VPNClient.getDnsMarkTag(this.profileId)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`); // block all marked DNS requests if DNS server list is unavailable
    } else {
      dnsmasqEntries.push(`server=${dnsServers[0]}$${VPNClient.getDnsMarkTag(this.profileId)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`);
    }
    await fs.writeFileAsync(this._getDnsmasqConfigPath(), dnsmasqEntries.join('\n')).catch((err) => { });
    if (settings.routeDNS && settings.strictVPN) {
      if (rtId) {
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        await this._enableDNSRoute("hard"); // enable hard route PBR rules, they will take effect immediately
      }
    } else {
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => { });
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => { });
      await this._disableDNSRoute("hard");
    }
    dnsmasq.scheduleRestartDNSService();
    if (rtId) {
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getNetIpsetName(this.profileId)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getNetIpsetName(this.profileId)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getNetIpsetName(this.profileId)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getNetIpsetName(this.profileId)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
    }
    await vpnClientEnforcer.addVPNClientIPRules(this.getInterfaceName());
  }


  async start() {
    if (!this._started) {
      this._started = true;
      sem.emitEvent({
        type: "VPNClient:Started",
        profileId: this.profileId,
        toProcess: "FireMain"
      });
    }

    this._lastStartTime = Date.now();
    await this._prepareRoutes();
    await this.flushRemoteEndpointRoutes().catch((err) => { });
    await this._start().catch((err) => {
      log.error(`Failed to exec _start of VPN client ${this.profileId}`, err.message);
    });

    return new Promise((resolve, reject) => {
      let establishmentTask = null;
      // function to handle successful tunnel establishment
      const handleSuccessfulEstablishment = async () => {
        if (establishmentTask) {
          clearInterval(establishmentTask);
          establishmentTask = null;
        }
        await this._setCachedState(true);
        this._scheduleRefreshRoutes();
        await this.addRemoteEndpointRoutes().catch((err) => { });
        if (f.isMain()) {
          // check connectivity and emit link_established or link_broken later, before which routes are already added and ping test using fwmark will work properly
          setTimeout(() => {
            this._checkConnectivity(true).catch((err) => {
              log.error(`Failed to check connectivity on VPN client ${this.profileId}`, err.message);
            });
          }, 20000);
        }
        if (!f.isMain()) {
          sem.emitEvent({
            type: "VPNClient:Started",
            profileId: this.profileId,
            toProcess: "FireMain"
          });
        }
        const timeElapsed = (Date.now() - this._lastStartTime) / 1000;
        log.info(`Time elapsed to start ${this.constructor.getProtocol()} client ${this.profileId}: ${timeElapsed} seconds`);
        resolve({ result: true });
      };

      // function to handle failed tunnel establishment
      const handleFailedEstablishment = async (reason) => {
        if (establishmentTask) {
          clearInterval(establishmentTask);
          establishmentTask = null;
        }
        const errMsg = await this.getMessage();
        log.error(`Failed to establish tunnel for VPN client ${this.profileId}. Reason: ${reason || 'Unknown error'}`, errMsg ? `Details: ${errMsg}` : '');
        resolve({ result: false, errMsg: errMsg });
      };

      setTimeout(async () => {
        try {
          const isUpInitial = await this._isLinkUp();
          if (isUpInitial) {
            await handleSuccessfulEstablishment();
            return;
          }
        } catch (err) {
          await handleFailedEstablishment(`Initial link check failed: ${err.message}`);
          return;
        }

        const startTime = Date.now();
        establishmentTask = setInterval(async () => {
          try {
            const isUp = await this._isLinkUp();
            if (isUp) {
              await handleSuccessfulEstablishment();
            } else {
              const now = Date.now();
              if (now - startTime > 60000) { // 60 seconds timeout
                await handleFailedEstablishment(`Timed out after 60 seconds`);
              }
            }
          } catch (err) {
            await handleFailedEstablishment(`Link check during interval failed: ${err.message}`);
          }
        }, 2000);
      }, 500);
    });
  }

  async stop() {
    // flush routes before stop vpn client to ensure smooth switch of traffic routing
    const intf = this.getInterfaceName();
    this._started = false;
    await this._resetRouteMarkInRedis();
    await VPNClient.ensureCreateEnforcementEnv(this.profileId);
    await vpnClientEnforcer.flushVPNClientRoutes(intf);
    await vpnClientEnforcer.removeVPNClientIPRules(intf);

    await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_VC_SNAT -m set --match-set ${VPNClient.getNetIpsetName(this.profileId, 4)}4 dst -j RETURN`)).catch((err) => { });
    await exec(iptables.wrapIptables(`sudo ip6tables -w -t nat -D FW_VC_SNAT -m set --match-set ${VPNClient.getNetIpsetName(this.profileId, 6)}6 dst -j RETURN`)).catch((err) => { });

    await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_VC_SNAT -o ${intf} -j MASQUERADE`)).catch((err) => { });
    await exec(iptables.wrapIptables(`sudo ip6tables -w -t nat -D FW_VC_SNAT -o ${intf} -j MASQUERADE`)).catch((err) => { });
    await this.loadSettings();
    const dnsServers = await this._getDNSServers() || [];
    if (dnsServers.length > 0) {
      // always attempt to remove dns redirect rule, no matter whether 'routeDNS' in set in settings
      await vpnClientEnforcer.unenforceDNSRedirect(this.getInterfaceName(), dnsServers, VPNClient.getDNSRedirectChainName(this.profileId));
    }
    await this.flushRemoteEndpointRoutes().catch((err) => { });
    await this._stop().catch((err) => {
      log.error(`Failed to exec _stop of VPN client ${this.profileId}`, err.message);
    });
    await vpnClientEnforcer.unenforceStrictVPN(this.getInterfaceName());
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => { });
    await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => { });
    await exec(`sudo ipset flush -! ${VPNClient.getSelfIpsetName(this.profileId, 4)}`).catch((err) => { });
    await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_EXT_IP -m set --match-set ${VPNClient.getSelfIpsetName(this.profileId, 4)} dst -i ${this.getInterfaceName()} -j FW_PRERT_PORT_FORWARD`)).catch((err) => { });
    await fs.unlinkAsync(this._getDnsmasqConfigPath()).catch((err) => { });
    await this._disableDNSRoute("hard");
    await this._disableDNSRoute("soft");
    const DNSMASQ = require('../dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    dnsmasq.scheduleRestartDNSService();
    await this._setCachedState(false);

    if (!f.isMain()) {
      sem.emitEvent({
        type: "VPNClient:Stopped",
        profileId: this.profileId,
        toProcess: "FireMain"
      });
    }
  }

  isStarted() {
    return this._started;
  }

  isIPv6Enabled() {
    return false;
  }

  async status() {
    // cached state is usually set by checkConnectivity in firemain process
    let status = await this._getCachedState();
    // if not set, it is not managed by firemain, and fireapi will populate the cached state
    if (status === null) {
      status = await this._isLinkUp();
      await this._setCachedState(status);
      return status;
    } else
      return status;
  }

  async getStatistics() {
    const status = await this.status();
    if (!status)
      return {};

    const intf = this.getInterfaceName();
    const rxBytes = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/rx_bytes`, 'utf8').then(r => Number(r.trim())).catch(() => 0);
    const txBytes = await fs.readFileAsync(`/sys/class/net/${intf}/statistics/tx_bytes`, 'utf8').then(r => Number(r.trim())).catch(() => 0);
    return { bytesIn: rxBytes, bytesOut: txBytes };
  }

  async destroy() {
    await vpnClientEnforcer.destroyRtId(this.getInterfaceName());
    await fs.unlinkAsync(this._getSettingsPath()).catch((err) => { });
    await fs.unlinkAsync(this._getJSONConfigPath()).catch((err) => { });
    await this._deleteCachedState();
    delete instances[this.profileId];
  }

  getInterfaceName() {
    if (!this.profileId) {
      throw new Error("profile id is not defined");
    }
    return `${Constants.VC_INTF_PREFIX}${this.profileId}`
  }

  static getOifIpsetName(uid) {
    if (uid) {
      return `c_oif_${uid.substring(0, 13)}_set`;
    } else
      return null;
  }

  static getRouteIpsetName(uid, hard = true) {
    if (uid) {
      return `c_rt_${hard ? "hard" : "soft"}_${uid.substring(0, 13)}_set`;
    } else
      return null;
  }

  static getNetIpsetName(uid) {
    if (uid) {
      return `c_net_${uid.substring(0, 13)}_set`;
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
    await lock.acquire(`VC_ENFORCE_${uid}`, async () => {
      if (!uid)
        return;
      if (envCreatedMap[uid])
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

      const netIpsetName = VPNClient.getNetIpsetName(uid);
      const netIpsetName4 = `${netIpsetName}4`;
      const netIpsetName6 = `${netIpsetName}6`;
      await exec(`sudo ipset create -! ${netIpsetName4} hash:net maxelem 16`).catch((err) => { });
      await exec(`sudo ipset create -! ${netIpsetName6} hash:net family inet6 maxelem 16`).catch((err) => { });

      const oifIpsetName = VPNClient.getOifIpsetName(uid);
      const oifIpsetName4 = `${oifIpsetName}4`;
      const oifIpsetName6 = `${oifIpsetName}6`;
      await exec(`sudo ipset create -! ${oifIpsetName} list:set`).catch((err) => {
        log.error(`Failed to create vpn client oif ipset ${oifIpsetName}`, err.message);
      });
      // vpn interface name is unique and will not conflict with others, so ipset can be populated here and leave it unchanged in start/stop
      await exec(`sudo ipset create -! ${oifIpsetName4} hash:net,iface maxelem 10`).catch((err) => { });
      await exec(`sudo ipset create -! ${oifIpsetName6} hash:net,iface family inet6 maxelem 10`).catch((err) => { });
      await exec(`sudo ipset add -! ${oifIpsetName} ${oifIpsetName4}`).catch((err) => { });
      await exec(`sudo ipset add -! ${oifIpsetName} ${oifIpsetName6}`).catch((err) => { });

      const dnsRedirectChain = VPNClient.getDNSRedirectChainName(uid);
      await exec(`sudo iptables -w -t nat -N ${dnsRedirectChain} &>/dev/null || true`).catch((err) => {
        log.error(`Failed to create vpn client DNS redirect chain ${dnsRedirectChain}`, err.message);
      });
      await exec(`sudo ip6tables -w -t nat -N ${dnsRedirectChain} &>/dev/null || true`).catch((err) => {
        log.error(`Failed to create ipv6 vpn client DNS redirect chain ${dnsRedirectChain}`, err.message);
      });

      await fs.mkdirAsync(VPNClient.getDNSRouteConfDir(uid, "hard")).catch((err) => { });
      await fs.mkdirAsync(VPNClient.getDNSRouteConfDir(uid, "soft")).catch((err) => { });
      envCreatedMap[uid] = 1;
    }).catch((err) => {
      log.error(`Failed to create enforcement env for VPN client ${uid}`, err.message);
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
    const promises = [];
    const result = { profileId: this.profileId };
    promises.push((async () => {
      const settings = await this.loadSettings();
      result.settings = settings;
      const routedSubnets = await this.getEffectiveRoutedSubnets();
      result.routedSubnets = routedSubnets;
    })());
    promises.push((async () => {
      result.status = await this.status();
    })());
    promises.push((async () => {
      result.stats = await this.getStatistics();
    })());
    promises.push((async () => {
      result.message = await this.getMessage();
    })());
    promises.push((async () => {
      result.type = await this.constructor.getProtocol();
    })());
    promises.push((async () => {
      result.config = await this.loadJSONConfig() || {};
    })());
    promises.push((async () => {
      result.remoteIP = await this._getRemoteIP();
    })());
    promises.push((async () => {
      result.remoteIP6 = await this._getRemoteIP6();
    })());
    promises.push((async () => {
      result.localIP = await this._getLocalIP();
    })());
    promises.push((async () => {
      result.rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    })());
    promises.push((async () => {
      result.dnsServers = await this._getDNSServers() || [];
    })());
    promises.push((async () => {
      result.sessionLog = includeContent ? await this.getLatestSessionLog() : null;
    })());
    await Promise.all(promises).catch((err) => {
      log.error(`Failed to get attributes of VPN Client ${this.profileId}`, err.message);
    });
    return result;
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
      if (ip && ip !== "0.0.0.0") // 0.0.0.0 is a placeholder if IPv4 is disabled in DDNS
        return ip;
    }
    return null;
  }

  // do more evaluation other than ping tests in this function and return boolean
  async _checkInternetAvailability() {
    return true;
  }

  async _isInternetAvailable() {
    if (!this._started)
      return true;
    const up = await this._isLinkUp();
    if (!up)
      return true;
    const targets = this.settings && this.settings.pingTestTargets || [];
    if (_.isEmpty(targets)) {
      const dnsServers = await this._getDNSServers();
      if (!_.isEmpty(dnsServers))
        Array.prototype.push.apply(targets, dnsServers.slice(0, 3));
      else {
        if (this.settings.overrideDefaultRoute)
          Array.prototype.push.apply(targets, ["1.1.1.1", "8.8.8.8", "9.9.9.9"]);
      }
    }
    if (_.isEmpty(targets)) {
      log.warn(`Cannot find any target for ping tests on VPN client ${this.profileId}`);
      return true;
    }
    const count = this.settings && this.settings.pingTestCount || 8;
    const results = await Promise.all(targets.map(target => this._runPingTest(target, count)));
    // TODO: evaluate ping test results and return false if it is lower than the threshold

    const ratio = results.reduce((total, item) => total + item.successCount, 0) * 100 / (results.length * count);
    log.verbose(`VPN ${this.profileId} tests [${targets}] success ratio ${ratio}%`);
    return await this._checkInternetAvailability();
  }

  async _runPingTest(target, count = 8) {
    const result = { target, totalCount: count };
    const af = new Address4(target).isValid() ? 4 : 6;
    const ping = af == 4 ? "ping" : "ping6";
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName()); // rt id will be used as mark of ping packets
    const ips = af == 4 ? await this.getVpnIP4s() : await this.getVpnIP6s();
    let optI = "";
    if (_.isArray(ips) && ips.length > 0) {
      const srcIp = af == 4 ? new Address4(ips[0]) : new Address6(ips[0]);
      optI = `-I ${srcIp.addressMinusSuffix}`;
    }
    const cmd = `sudo ${ping} -n -q -m ${rtId} -c ${count} ${optI} -W 1 -i 1 ${target} | grep "received" | awk '{print $4}'`;
    await exec(cmd).then((output) => {
      result.successCount = Number(output.stdout.trim());
    }).catch((err) => {
      result.successCount = 0;
    });
    log.debug(`Ping test result on VPN client ${this.profileId}`, result);
    return result;
  }

  async _setRouteMarkInRedis() {
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName());
    await rclient.setAsync(VPNClient.getRouteMarkKey(this.profileId), rtId);
  }

  async _resetRouteMarkInRedis() {
    await rclient.unlinkAsync(VPNClient.getRouteMarkKey(this.profileId));
  }

  static getRouteMarkKey(profileId) {
    return `${Constants.VPN_ROUTE_MARK_KEY_PREFIX}:${profileId}`;
  }

  async getLatestSessionLog() {
    return null;
  }

  static getStateCacheKey(profileId) {
    return `VC:${profileId}:connState`;
  }

  async _setCachedState(state) {
    await rclient.setAsync(VPNClient.getStateCacheKey(this.profileId), state);
    await rclient.expireAsync(VPNClient.getStateCacheKey(this.profileId), 86400 * 7);
  }

  async _getCachedState() {
    const state = await rclient.getAsync(VPNClient.getStateCacheKey(this.profileId));
    switch (state) {
      case "true":
        return true;
      case "false":
        return false;
      default:
        return null;
    }
  }

  async _deleteCachedState() {
    await rclient.delAsync(VPNClient.getStateCacheKey(this.profileId));
  }

  static async notifyWanSwitched() {
    const profileIds = Object.keys(instances);
    profileIds.forEach(id => {
      log.info(`VPN client ${id} need to execute lan switched ...`);
      sem.emitEvent({
        type: "link_wan_switched",
        profileId: id,
        suppressEventLogging: true,
      });
    });
  }
}

module.exports = VPNClient;
