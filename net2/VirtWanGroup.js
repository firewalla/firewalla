/*    Copyright 2020-2022 Firewalla Inc.
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

const log = require('./logger.js')(__filename);

const exec = require('child-process-promise').exec;
const VPNClient = require('../extension/vpnclient/VPNClient.js');
const fs = require('fs');
const Promise = require('bluebird');
const routing = require('../extension/routing/routing.js');
const { wrapIptables } = require('./Iptables');
const ipset = require('./Ipset.js');
Promise.promisifyAll(fs);
const f = require('./Firewalla.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const _ = require('lodash');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_REFRESH = "LOCK_REFRESH_RT";
const ipTool = require('ip');
const Constants = require('./Constants.js');
const rclient = require('../util/redis_manager.js').getRedisClient();
const envCreatedMap = {};

const instances = {};

class VirtWanGroup {
  constructor(o) {
    const uuid = o.uuid;
    if (!uuid)
      return null;
    if (!instances[uuid]) {
      this.uuid = uuid;
      this.name = o.name;
      this.wans = o.wans;
      this.type = o.type;
      this.strictVPN = o.strictVPN || false;
      if (this.type === "primary_standby")
        this.failback = o.failback || false;
      
      this.connState = {};
      this.applyConfig();
      instances[uuid] = this;
      if (f.isMain()) {
        this._linkStateEventListener = async (event) => {
          if (this.wans.some(wan => wan.profileId === event.profileId)) {
            await this.processLinkStateEvent(event);
          }
        };
        sem.on("link_established", this._linkStateEventListener);
        sem.on("link_broken", this._linkStateEventListener);
        this._refreshRTListener = async (event) => {
          if (this.wans.some(wan => wan.profileId === event.profileId)) {
            await this.refreshRT(event).catch((err) => {
              log.error(`Failed to refresh routing table of virtual wan group ${this.uuid}`. err.message);
            });
          }
        }
        sem.on("VPNClient:Stopped", this._refreshRTListener);
        sem.on("VPNClient:SettingsChanged", this._refreshRTListener);
      }
    } else
      instances[uuid].update(o);
    return instances[uuid];
  }

  update(o) {
    let refreshNeeded = false;
    if (!_.isEqual(this.wans, o.wans) || !_.isEqual(this.type, o.type) || !_.isEqual(this.failback, o.failback) || !_.isEqual(this.strictVPN, o.strictVPN))
      refreshNeeded = true;
    this.name = o.name;
    this.wans = o.wans;
    this.type = o.type;
    this.strictVPN = o.strictVPN || false;
    if (this.type === "primary_standby")
      this.failback = o.failback || false;
    else
      delete this.failback;
    this.applyConfig();
    return refreshNeeded;
  }

  static getRedisKeyName(uuid) {
    return `virt_wan_group:${uuid}`;
  }

  static getRouteIpsetName(uid, hard = true) {
    if (uid) {
      return `c_vwg_${hard ? "hard" : "soft"}_${uid.substring(0, 13)}_set`;
    } else
      return null;
  }

  static getDNSRedirectChainName(uid) {
    return `FW_PR_VWG_DNS_${uid.substring(0, 13)}`;
  }

  static async ensureCreateEnforcementEnv(uid) {
    await lock.acquire(`VWG_ENFORCE_${uid}`, async () => {
      if (!uid)
        return;
      if (envCreatedMap[uid])
        return;
      const hardRouteIpsetName = VirtWanGroup.getRouteIpsetName(uid);
      await exec(`sudo ipset create -! ${hardRouteIpsetName} list:set skbinfo`).catch((err) => {
        log.error(`Failed to create virtual wan group routing ipset ${hardRouteIpsetName}`, err.message);
      });

      const softRouteIpsetName = VirtWanGroup.getRouteIpsetName(uid, false);
      await exec(`sudo ipset create -! ${softRouteIpsetName} list:set skbinfo`).catch((err) => {
        log.error(`Failed to create virtual wan group routing ipset ${softRouteIpsetName}`, err.message);
      });

      const dnsRedirectChain = VirtWanGroup.getDNSRedirectChainName(uid);
      await exec(`sudo iptables -w -t nat -N ${dnsRedirectChain} &>/dev/null || true`).catch((err) => {
        log.error(`Failed to create virtual wan group DNS redirect chain ${dnsRedirectChain}`, err.message);
      });
      await exec(`sudo ip6tables -w -t nat -N ${dnsRedirectChain} &>/dev/null || true`).catch((err) => {
        log.error(`Failed to create ipv6 virtual wan group DNS redirect chain ${dnsRedirectChain}`, err.message);
      });

      await fs.promises.mkdir(VirtWanGroup.getDNSRouteConfDir(uid, "hard")).catch((err) => { });
      await fs.promises.mkdir(VirtWanGroup.getDNSRouteConfDir(uid, "soft")).catch((err) => { });
      envCreatedMap[uid] = 1;
    }).catch((err) => {
      log.error(`Failed to create enforcement env for VWG ${uid}`, err.message);
    });
  }

  async refreshRT() {
    await lock.acquire(`${LOCK_REFRESH}_${this.uuid}`, async () => {
      await routing.flushRoutingTable(this._getRTName()).catch((err) => {});
      if (this.strictVPN === true) {
        await routing.addRouteToTable("default", null, null, this._getRTName(), 65536, 4, "unreachable").catch((err) => {});
        await routing.addRouteToTable("default", null, null, this._getRTName(), 65536, 6, "unreachable").catch((err) => {});
      }
      let anyWanEnabled = false;
      let anyWanReady = false;
      const routedDnsServers = [];
      switch (this.type) {
        case "single":
        case "primary_standby": {
          const wans = Object.values(this.connState).sort((w1, w2) => w1.seq - w2.seq);
          let activeWanFound = false;
          for (const wan of wans) {
            const profileId = wan.profileId
            const c = VPNClient.getInstance(profileId);
            if (!c || !c.isStarted()) {
              log.warn(`VPN client ${profileId} is not found or is not started in virtual wan group ${this.uuid}, skip it in refreshRT`);
              wan.ready = false;
              wan.active = false;
              wan.enabled = false;
              continue;
            }
            if (wan.ready)
              anyWanReady = true;
            anyWanEnabled = true;
            wan.enabled = true;
            if (!activeWanFound && wan.ready === true)
              wan.active = true;
            else
              wan.active = false;
            const metric = wan.seq + 1 + (wan.ready ? 0 : 100);
            const gw = await c._getRemoteIP();
            await routing.addRouteToTable("default", gw, c.getInterfaceName(), this._getRTName(), metric, 4).catch((err) => {});
            const dnsServers = await c._getDNSServers() || [];
            for (const dnsServer of dnsServers) {
              let af = 4;
              if (!ipTool.isV4Format(dnsServer) && ipTool.isV6Format(dnsServer)) {
                af = 6;
              }
              await routing.addRouteToTable(dnsServer, gw, c.getInterfaceName(), this._getRTName(), metric, af).catch((err) => {});
            }
            const vpnSubnets = await c.getRoutedSubnets();
            if (_.isArray(vpnSubnets)) {
              for (const vpnSubnet of vpnSubnets) {
                let af = 4;
                if (!ipTool.isV4Format(vpnSubnet) && ipTool.isV6Format(vpnSubnet))
                  af = 6;
                await routing.addRouteToTable(vpnSubnet, gw, c.getInterfaceName(), this._getRTName(), metric, af).catch((err) => {});
              }
            }
            const settings = await c.loadSettings();
            if (wan.ready && settings.routeDNS)
              Array.prototype.push.apply(routedDnsServers, dnsServers);
          }
          break;
        }
        case "load_balance": {
          let seq = 0;
          const wans = Object.values(this.connState);
          const multiPathDesc = [];
          for (const wan of wans) {
            const profileId = wan.profileId
            const c = VPNClient.getInstance(profileId);
            if (!c || !c.isStarted()) {
              log.warn(`VPN client ${profileId} is not found or is not started in virtual wan group ${this.uuid}, skip it in refreshRT`);
              wan.ready = false;
              wan.active = false;
              wan.enabled = false;
              continue;
            }
            if (wan.ready)
              anyWanReady = true;
            anyWanEnabled = true;
            wan.enabled = true;
            wan.active = wan.ready;
            let metric = seq + 1;
            const gw = await c._getRemoteIP();
            if (wan.ready) {
              multiPathDesc.push({nextHop: gw, dev: c.getInterfaceName(), weight: wan.weight});
            } else {
              metric = seq + 1 + 100;
              await routing.addRouteToTable("default", gw, c.getInterfaceName(), this._getRTName(), metric, 4).catch((err) => {});
            }
            const dnsServers = await c._getDNSServers() || [];
            for (const dnsServer of dnsServers) {
              let af = 4;
              if (!ipTool.isV4Format(dnsServer) && ipTool.isV6Format(dnsServer)) {
                af = 6;
              }
              await routing.addRouteToTable(dnsServer, gw, c.getInterfaceName(), this._getRTName(), metric, af).catch((err) => {});
            }
            const vpnSubnets = await c.getRoutedSubnets();
            if (_.isArray(vpnSubnets)) {
              for (const vpnSubnet of vpnSubnets) {
                let af = 4;
                if (!ipTool.isV4Format(vpnSubnet) && ipTool.isV6Format(vpnSubnet))
                  af = 6;
                await routing.addRouteToTable(vpnSubnet, gw, c.getInterfaceName(), this._getRTName(), metric, af).catch((err) => { });
              }
            }
            const settings = await c.loadSettings();
            if (wan.ready && settings.routeDNS)
              Array.prototype.push.apply(routedDnsServers, dnsServers);
            seq++;
          }
          if (multiPathDesc.length > 0)
            await routing.addMultiPathRouteToTable("default", this._getRTName(), 4, ...multiPathDesc).catch((err) => {});
          break;
        }
        default:
      }
      log.info(`Routing table of virtual wan group ${this.uuid} is refreshed, final state: `, this.connState);
      // save connState to redis
      await rclient.hsetAsync(VirtWanGroup.getRedisKeyName(this.uuid), "connState", JSON.stringify(this.connState));
      const rtId = await routing.createCustomizedRoutingTable(this._getRTName(), routing.RT_TYPE_VC);
      if (!rtId)
        return;
        const rtIdHex = Number(rtId).toString(16);
      if (anyWanEnabled && this.strictVPN || anyWanReady) {
        // populate hard route ipset with skbmark
        await exec(`sudo ipset add -! ${VirtWanGroup.getRouteIpsetName(this.uuid)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
        await exec(`sudo ipset add -! ${VirtWanGroup.getRouteIpsetName(this.uuid)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
        if (!_.isEmpty(routedDnsServers)) {
          await exec(`sudo ipset add -! ${VirtWanGroup.getRouteIpsetName(this.uuid)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
          await this._enableDNSRoute("hard");
        } else {
          await exec(`sudo ipset del -! ${VirtWanGroup.getRouteIpsetName(this.uuid)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => {});
          await this._disableDNSRoute("hard");
        }
      } else {
        await exec(`sudo ipset flush -! ${VirtWanGroup.getRouteIpsetName(this.uuid)}`).catch((err) => {});
        await this._disableDNSRoute("hard");
      }
      if (anyWanReady) {
        // populate soft route ipset with skbmark
        await exec(`sudo ipset add -! ${VirtWanGroup.getRouteIpsetName(this.uuid, false)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET4} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        await exec(`sudo ipset add -! ${VirtWanGroup.getRouteIpsetName(this.uuid, false)} ${ipset.CONSTANTS.IPSET_MATCH_ALL_SET6} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
        if (!_.isEmpty(routedDnsServers)) {
          await exec(`sudo ipset add -! ${VirtWanGroup.getRouteIpsetName(this.uuid, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
          await this._enableDNSRoute("soft");
        } else {
          await exec(`sudo ipset del -! ${VirtWanGroup.getRouteIpsetName(this.uuid, false)} ${ipset.CONSTANTS.IPSET_MATCH_DNS_PORT_SET} skbmark 0x${rtIdHex}/${routing.MASK_ALL}`).catch((err) => { });
          await this._disableDNSRoute("soft");
        }
      } else {
        await exec(`sudo ipset flush -! ${VirtWanGroup.getRouteIpsetName(this.uuid, false)}`).catch((err) => {});
        await this._disableDNSRoute("soft");
      }
      if (!_.isEmpty(routedDnsServers)) {
        await fs.promises.writeFile(this._getDnsmasqConfigPath(), `mark=${rtId}$${VirtWanGroup.getDnsMarkTag(this.uuid)}$*!${Constants.DNS_DEFAULT_WAN_TAG}\nserver=${routedDnsServers[0]}$${VirtWanGroup.getDnsMarkTag(this.uuid)}$*!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
      } else {
        await fs.promises.unlink(this._getDnsmasqConfigPath()).catch((err)=> {});
      }
      const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
      const dnsmasq = new DNSMASQ();
      dnsmasq.scheduleRestartDNSService();
      await this._updateDNSRedirectChain(routedDnsServers);
    }).catch((err) => {
      log.error(`Failed to refresh routing table of virtual wan group ${this.uuid}`, err.message);
    });
  }

  static getDnsMarkTag(uuid) {
    return `vwg_${uuid.substring(0, 13)}`;
  }

  async _updateDNSRedirectChain(dnsServers) {
    log.info(`Updating dns redirect chain for virtual wan group ${this.uuid}`, dnsServers);

    const chain = VirtWanGroup.getDNSRedirectChainName(this.uuid);
    const rtId = await routing.createCustomizedRoutingTable(this._getRTName(), routing.RT_TYPE_VC);
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
        let cmd = wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await exec(cmd).catch((err) => {
          log.error(`Failed to update DNS redirect chain: ${cmd}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await exec(cmd).catch((err) => {
          log.error(`Failed to update DNS redirect chain: ${cmd}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC}  -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await exec(cmd).catch((err) => {
          log.error(`Failed to update DNS redirect chain: ${cmd}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo ${bin} -w -t nat -I ${chain} -m mark --mark 0x${rtIdHex}/${routing.MASK_VC}  -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await exec(cmd).catch((err) => {
          log.error(`Failed to update DNS redirect chain: ${cmd}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }

  async processLinkStateEvent(e) {
    let refreshRTNeeded = false;
    await lock.acquire(`${LOCK_REFRESH}_${this.uuid}`, async () => {
      const profileId = e.profileId;
      switch (e.type) {
        case "link_established": {
          if (this.connState[profileId] && this.connState[profileId].ready === false) {
            if (this.type === "primary_standby" && (this.connState[profileId].seq === 0 && this.failback === true || !Object.values(this.connState).some(wan => wan.ready === true))
              || this.type === "load_balance"
              || this.connState[profileId].enabled === false)
              refreshRTNeeded = true;
            this.connState[profileId].ready = true;
          }
          break;
        }
        case "link_broken": {
          if (this.connState[profileId] && this.connState[profileId].ready === true) {
            if (this.connState[profileId].active === true && this.type !== "single")
              refreshRTNeeded = true;
            this.connState[profileId].ready = false;
          }
          break;
        }
        default:
      }
    }).catch((err) => {
      log.error(`Failed to process link state event of virtual wan group ${this.uuid}`, e, err.message);
    });
    if (refreshRTNeeded) {
      await this.refreshRT().catch((err) => {
        log.error(`Failed to refresh routing table of virtual wan group ${this.uuid}`. err.message);
      });
    }
  }

  _getRTName() {
    return `vwg_${this.uuid.substring(0, 13)}`;
  }

  _getDnsmasqConfigPath() {
    return `${f.getUserConfigFolder()}/dnsmasq/vwg_${this.uuid}.conf`;
  }

  _getDnsmasqRouteConfigPath(routeType = "hard") {
    return `${f.getUserConfigFolder()}/dnsmasq/vwg_${this.uuid}_${routeType}.conf`;
  }

  static getDNSRouteConfDir(uuid, routeType = "hard") {
    return `${f.getUserConfigFolder()}/dnsmasq/VWG:${uuid}_${routeType}`;
  }

  async _enableDNSRoute(routeType = "hard") {
    const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    await fs.promises.writeFile(this._getDnsmasqRouteConfigPath(routeType), `conf-dir=${VirtWanGroup.getDNSRouteConfDir(this.uuid, routeType)}`).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  async _disableDNSRoute(routeType = "hard") {
    const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
    const dnsmasq = new DNSMASQ();
    await fs.promises.unlink(this._getDnsmasqRouteConfigPath(routeType)).catch((err) => {});
    dnsmasq.scheduleRestartDNSService();
  }

  applyConfig() {
    const previousState = JSON.parse(JSON.stringify(this.connState));
    this.connState = {};
    for (const wan of this.wans) {
      const profileId = wan.profileId;
      switch (this.type) {
        case "single":
        case "primary_standby": {
          this.connState[profileId] = {
            profileId: profileId,
            seq: wan.seq,
            ready: previousState.hasOwnProperty(profileId) ? previousState[profileId].ready : true,
            active: previousState.hasOwnProperty(profileId) ? previousState[profileId].active : false
          };
          break;
        }
        case "load_balance": {
          this.connState[profileId] = {
            profileId: profileId,
            weight: wan.weight,
            ready: previousState.hasOwnProperty(profileId) ? previousState[profileId].ready : true,
            active: previousState.hasOwnProperty(profileId) ? previousState[profileId].active : false
          };
          break;
        }
        default:
      }
    }
  }

  // this function is invoked when the virtual wan group is created or initialized in a process's lifecycle
  async createEnv() {
    await VirtWanGroup.ensureCreateEnforcementEnv(this.uuid);
    const rtId = await routing.createCustomizedRoutingTable(this._getRTName(), routing.RT_TYPE_VC);
    if (!rtId)
      return;
    if (!["single", "primary_standby", "load_balance"].includes(this.type)) {
      log.error(`Unsupported routing type for virtual wan group ${this.uuid}: ${this.type}`);
      return;
    }
    await exec(wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_DNS_VPN_CLIENT -j ${VirtWanGroup.getDNSRedirectChainName(this.uuid)}`)).catch((err) => {});
    await exec(wrapIptables(`sudo ip6tables -w -t nat -A FW_PREROUTING_DNS_VPN_CLIENT -j ${VirtWanGroup.getDNSRedirectChainName(this.uuid)}`)).catch((err) => {});
    // create ip rule
    await routing.createPolicyRoutingRule("all", null, this._getRTName(), 6000, `${rtId}/${routing.MASK_VC}`);
    await routing.createPolicyRoutingRule("all", null, this._getRTName(), 6000, `${rtId}/${routing.MASK_VC}`, 6);
  }

  // this function is invoked when the virtual wan group is removed
  async destroyEnv() {
    await VirtWanGroup.ensureCreateEnforcementEnv(this.uuid);
    const rtId = await routing.createCustomizedRoutingTable(this._getRTName(), routing.RT_TYPE_VC);
    if (!rtId)
      return;
    await exec(wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -j ${VirtWanGroup.getDNSRedirectChainName(this.uuid)}`)).catch((err) => {});
    await exec(wrapIptables(`sudo ip6tables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -j ${VirtWanGroup.getDNSRedirectChainName(this.uuid)}`)).catch((err) => {});
    // flush ipset with skbmark
    await exec(`sudo ipset flush -! ${VirtWanGroup.getRouteIpsetName(this.uuid)}`).catch((err) => {});
    await exec(`sudo ipset flush -! ${VirtWanGroup.getRouteIpsetName(this.uuid, false)}`).catch((err) => {});
    // remove ip rule
    await routing.removePolicyRoutingRule("all", null, this._getRTName(), 6000, `${rtId}/${routing.MASK_VC}`).catch((err) => {});
    await routing.removePolicyRoutingRule("all", null, this._getRTName(), 6000, `${rtId}/${routing.MASK_VC}`, 6).catch((err) => {});
    // flush routing table
    await routing.flushRoutingTable(this._getRTName()).catch((err) => {});
    // remove customized routing table
    await routing.removeCustomizedRoutingTable(this._getRTName());
    // remove event listener
    if (this._linkStateEventListener) {
      sem.removeListener("link_established", this._linkStateEventListener);
      sem.removeListener("link_broken", this._linkStateEventListener);
      this._linkStateEventListener = null;
    }
    if (this._refreshRTListener) {
      sem.removeListener("VPNClient:Stopped", this._refreshRTListener);
      sem.removeListener("VPNClient:SettingsChanged", this._refreshRTListener);
      this._refreshRTListener = null;
    }
    await this._disableDNSRoute("hard");
    await this._disableDNSRoute("soft");
    await fs.promises.unlink(this._getDnsmasqConfigPath()).catch((err) => {});
    await exec(`rm -rf ${VirtWanGroup.getDNSRouteConfDir(this.uuid, "hard")}`).catch((err) => {});
    await exec(`rm -rf ${VirtWanGroup.getDNSRouteConfDir(this.uuid, "soft")}`).catch((err) => {});
  }

  async toJson() {
    const json = {};
    json.uuid = this.uuid;
    json.name = this.name;
    json.type = this.type;
    json.wans = this.wans;
    json.strictVPN = this.strictVPN || false;
    if (this.type === "primary_standby")
      json.failback = this.failback || false;
    // read connState from redis, which is available in all processes
    const connState = await rclient.hgetAsync(VirtWanGroup.getRedisKeyName(this.uuid), "connState").then(result => JSON.parse(result)).catch((err) => null);
    if (connState)
      json.connState = connState;
    return json;
  }
}

module.exports = VirtWanGroup;