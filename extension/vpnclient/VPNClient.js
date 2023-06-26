/*    Copyright 2016-2022 Firewalla Inc.
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
const PlatformLoader = require('../../platform/PlatformLoader.js');
const { rclient } = require('../../util/redis_manager.js');
const Constants = require('../../net2/Constants.js');
const AsyncLock = require('../../vendor_lib/async-lock');
const lock = new AsyncLock();
const platform = PlatformLoader.getPlatform()
const envCreatedMap = {};

const instances = {};

const VPN_ROUTE_MARK_KEY_PREFIX = "fwmark:vpn";
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

        setInterval(() => {
          this.evaluateQuality().catch((err) => {
            log.error(`Failed to evaluate quality on VPN client ${this.profileId}`, err.message);
          });
        }, 20000);

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
                  profileId: this.profileId
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

  static async getVPNProfilesForInit(json) {
    const types = ["openvpn", "wireguard", "ssl", "zerotier", "nebula", "trojan", "clash", "ipsec", "ts"];
    await Promise.all(types.map(async (type) => {
      const c = this.getClass(type);
      if (c) {
        let profiles = [];
        const profileIds = await c.listProfileIds();
        Array.prototype.push.apply(profiles, await Promise.all(profileIds.map(profileId => new c({profileId: profileId}).getAttributes())));
        json[c.getKeyNameForInit()] = profiles;
      }
    }));
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
      case "ts": {
        const c = require('./docker/TSDockerClient.js');
        return c;
        break;
      }
      default:
        log.error(`Unrecognized VPN client type: ${type}`);
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
    const intf = this.getInterfaceName();
    const snatNeeded = await this.isSNATNeeded();
    if (snatNeeded)
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -A FW_POSTROUTING -o ${intf} -j MASQUERADE`)).catch((err) => {});
    log.info(`Refresh VPN client routes for ${this.profileId}, remote: ${remoteIP}, intf: ${intf}`);
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
    const dnsServers = await this._getDNSServers() || [];

    log.info(`Adding routes for vpn ${this.profileId}`, routedSubnets);
    // always add default route into VPN client's routing table, the switch is implemented in ipset, so no need to implement it in routing tables
    await vpnClientEnforcer.enforceVPNClientRoutes(remoteIP, intf, routedSubnets, dnsServers, true);
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
    await fs.writeFileAsync(this._getDnsmasqConfigPath(), dnsmasqEntries.join('\n')).catch((err) => {});
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
        await vpnClientEnforcer.enforceDNSRedirect(this.getInterfaceName(), dnsServers, await this._getRemoteIP(), dnsRedirectChain);
      }
      dnsmasq.scheduleRestartDNSService();
    } else {
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => { });
      if (!settings.strictVPN)
        await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => { });
      if (dnsServers.length > 0)
        await vpnClientEnforcer.unenforceDNSRedirect(this.getInterfaceName(), dnsServers, await this._getRemoteIP(), dnsRedirectChain);
      await fs.unlinkAsync(this._getDnsmasqConfigPath()).catch((err) => {});
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
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getNetIpsetName(this.profileId)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getNetIpsetName(this.profileId)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getNetIpsetName(this.profileId)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getNetIpsetName(this.profileId)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
    }
    await exec(`sudo ipset flush -! ${VPNClient.getNetIpsetName(this.profileId)}4`).catch((err) => {});
    await exec(`sudo ipset flush -! ${VPNClient.getNetIpsetName(this.profileId)}6`).catch((err) => {});
    for (const routedSubnet of routedSubnets) {
      await exec(`sudo ipset add -! ${VPNClient.getNetIpsetName(this.profileId)}${new Address4(routedSubnet).isValid() ? "4" : "6"} ${routedSubnet}`).catch((err) => {});
    }
    const ip4s = await this.getVpnIP4s();
    await exec(`sudo ipset flush -! ${VPNClient.getSelfIpsetName(this.profileId, 4)}`).catch((err) => {});
    if (_.isArray(ip4s)) {
      for (const ip4 of ip4s) {
        await exec(`sudo ipset add -! ${VPNClient.getSelfIpsetName(this.profileId, 4)} ${ip4}`).catch((err) => {});
      }
    }
    // port forward on VPN client will be enabled by default, the port forward rule will decide if it takes effect on specific VPN client
    if (!settings.hasOwnProperty("enablePortforward") || settings.enablePortforward) {
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_VC_EXT_IP -m set --match-set ${VPNClient.getSelfIpsetName(this.profileId, 4)} dst -i ${this.getInterfaceName()} -j FW_PRERT_VC_PORT_FORWARD`)).catch((err) => {});
    } else {
      await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_VC_EXT_IP -m set --match-set ${VPNClient.getSelfIpsetName(this.profileId, 4)} dst -i ${this.getInterfaceName()} -j FW_PRERT_VC_PORT_FORWARD`)).catch((err) => {});
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
          await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
          await this._disableDNSRoute("soft");
          // clear hard route ipset if strictVPN (kill-switch) is not enabled
          if (!this.settings.strictVPN) {
            await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => {});
            await this._disableDNSRoute("hard");
            await this._resetRouteMarkInRedis();
          }
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

  getFwMark() {
    if (this.settings && this.settings.wanUUID) {
      const intf = sysManager.getWanInterfaces().find(iface => iface && iface.uuid === this.settings.wanUUID);
      if (intf) {
        return intf.rtid;
      }
    }
    return null;
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

  static getDNSRouteConfDir(profileId, routeType = "hard") {
    return `${f.getUserConfigFolder()}/dnsmasq/VC:${profileId}_${routeType}`;
  }

  async _enableDNSRoute(routeType = "hard") {
    const DNSMASQ = require('../dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    await fs.writeFileAsync(this._getDnsmasqRouteConfigPath(routeType), `conf-dir=${VPNClient.getDNSRouteConfDir(this.profileId, routeType)}`).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  async _disableDNSRoute(routeType = "hard") {
    const DNSMASQ = require('../dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    await fs.unlinkAsync(this._getDnsmasqRouteConfigPath(routeType)).catch((err) => {});
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
    await exec(`sudo ipset add -! ${oifIpsetName4} 0.0.0.0/1,${this.getInterfaceName()}`).catch((err) => {});
    await exec(`sudo ipset add -! ${oifIpsetName4} 128.0.0.0/1,${this.getInterfaceName()}`).catch((err) => {});
    await exec(`sudo ipset add -! ${oifIpsetName6} ::/1,${this.getInterfaceName()}`).catch((err) => {});
    await exec(`sudo ipset add -! ${oifIpsetName6} 8000::/1,${this.getInterfaceName()}`).catch((err) => {});
    // do not need to populate route ipset if strictVPN (kill-switch) is not enabled, it will be populated after link is established
    if (settings.strictVPN) {
      if (settings.overrideDefaultRoute && rtId) {
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
      } else {
        await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => {});
        await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
      }
      await vpnClientEnforcer.enforceStrictVPN(this.getInterfaceName());
      await this._setRouteMarkInRedis();
    } else {
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId)}`).catch((err) => {});
      await exec(`sudo ipset flush -! ${VPNClient.getRouteIpsetName(this.profileId, false)}`).catch((err) => {});
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
    await fs.writeFileAsync(this._getDnsmasqConfigPath(), dnsmasqEntries.join('\n')).catch((err) => {});
    if (settings.routeDNS && settings.strictVPN) {
      if (rtId) {
        await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
        await this._enableDNSRoute("hard"); // enable hard route PBR rules, they will take effect immediately
      }
    } else {
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => {});
      await exec(`sudo ipset del -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET}`).catch((err) => {});
      await this._disableDNSRoute("hard");
    }
    dnsmasq.scheduleRestartDNSService();
    if (rtId) {
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getNetIpsetName(this.profileId)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId)} ${VPNClient.getNetIpsetName(this.profileId)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getNetIpsetName(this.profileId)}4 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
      await exec(`sudo ipset add -! ${VPNClient.getRouteIpsetName(this.profileId, false)} ${VPNClient.getNetIpsetName(this.profileId)}6 skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
    }
    await vpnClientEnforcer.addVPNClientIPRules(this.getInterfaceName());
  }

  async start() {
    this._started = true;
    this._lastStartTime = Date.now();
    await this._prepareRoutes();
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
            if (f.isMain()) {
              sem.emitEvent({
                type: "link_established",
                profileId: this.profileId
              });
            }
            resolve({result: true});
          } else {
            const now = Date.now();
            if (now - startTime > 30000) {
              log.error(`Failed to establish tunnel for VPN client ${this.profileId} in 30 seconds`);
              clearInterval(establishmentTask);
              const errMsg = await this.getMessage();
              resolve({result: false, errMsg: errMsg});
            }
          }
        })().catch(async (err) => {
          log.error(`Failed to start VPN client ${this.profileId}`, err.message);
          clearInterval(establishmentTask);
          const errMsg = await this.getMessage();
          resolve({result: false, errMsg: errMsg});
        });
      }, 2000);
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
    await exec(iptables.wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_EXT_IP -m set --match-set ${VPNClient.getSelfIpsetName(this.profileId, 4)} dst -i ${this.getInterfaceName()} -j FW_PRERT_PORT_FORWARD`)).catch((err) => {});
    await fs.unlinkAsync(this._getDnsmasqConfigPath()).catch((err) => {});
    await this._disableDNSRoute("hard");
    await this._disableDNSRoute("soft");
    const DNSMASQ = require('../dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    dnsmasq.scheduleRestartDNSService();
    
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
    let sessionLog = null;
    if (includeContent) {
      sessionLog = await this.getLatestSessionLog();
    }
    return {profileId, settings, status, stats, message, routedSubnets, type, config, remoteIP, sessionLog};
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

  async evaluateQuality() {
    if (!this._started)
      return;
    const up = await this._isLinkUp();
    if (!up)
      return;
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
      return;
    }
    const count = this.settings && this.settings.pingTestCount || 8;
    const results = await Promise.all(targets.map(target => this._runPingTest(target, count)));
    // TODO: eveluate results and emit events accordingly,
    // e.g., link_established, link_broken, or new event types that can be hooked elsewhere (VirtWanGroup.js)

  }

  async _runPingTest(target, count = 8) {
    const result = {target, totalCount: count};
    const rtId = await vpnClientEnforcer.getRtId(this.getInterfaceName()); // rt id will be used as mark of ping packets
    const cmd = `sudo ping -n -q -m ${rtId} -c ${count} -W 1 -i 1 ${target} | grep "received" | awk '{print $4}'`;
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
    return `${VPN_ROUTE_MARK_KEY_PREFIX}:${profileId}`;
  }

  async getLatestSessionLog() {
    return null;
  }
}

module.exports = VPNClient;
