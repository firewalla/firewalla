/*    Copyright 2019 Firewalla Inc
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

const rclient = require('../util/redis_manager.js').getRedisClient();
const PolicyManager = require('./PolicyManager.js');
const pm = new PolicyManager();
const f = require('./Firewalla.js');
const {Rule} = require('./Iptables.js');
const ipset = require('./Ipset.js');
const exec = require('child-process-promise').exec;
const TagManager = require('./TagManager.js');
const Tag = require('./Tag.js');
const _ = require('lodash');
const fs = require('fs');
const Promise = require('bluebird');
const HostTool = require('./HostTool.js');
const hostTool = new HostTool();
Promise.promisifyAll(fs);
const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new Dnsmasq();
const Mode = require('./Mode.js');
const SpooferManager = require('./SpooferManager.js');
const OpenVPNClient = require('../extension/vpnclient/OpenVPNClient.js');
const vpnClientEnforcer = require('../extension/vpnclient/VPNClientEnforcer.js');
const instances = {}; // this instances cache can ensure that NetworkProfile object for each uuid will be created only once. 
                      // it is necessary because each object will subscribe NetworkPolicy:Changed message.
                      // this can guarantee the event handler function is run on the correct and unique object.

const envCreatedMap = {};

class NetworkProfile {
  constructor(o) {
    if (!instances[o.uuid]) {
      this.o = o;
      this._policy = {};
      const c = require('./MessageBus.js');
      this.subscriber = new c("info");
      if (f.isMain()) {
        if (o && o.uuid) {
          this.subscriber.subscribeOnce("DiscoveryEvent", "NetworkPolicy:Changed", this.o.uuid, (channel, type, id, obj) => {
            log.info(`Network policy is changed on ${this.o.intf}, uuid: ${this.o.uuid}`, obj);
            this.scheduleApplyPolicy();
          });
        }
      }
      instances[o.uuid] = this;
    }
    return instances[o.uuid];
  }

  update(o) {
    this.o = o;
  }

  toJson() {
    const json = Object.assign({}, this.o, {policy: this._policy});
    return json;
  }

  scheduleApplyPolicy() {
    if (this.applyPolicyTask)
      clearTimeout(this.applyPolicyTask);
    this.applyPolicyTask = setTimeout(() => {
      this.applyPolicy();
    }, 3000);
  }

  // in case gateway has multiple IPv6 addresses
  async rediscoverGateway6(mac) {
    const gatewayEntry = await hostTool.getMACEntry(mac).catch((err) => null);
    if (gatewayEntry)
      this._discoveredGateway6 = (gatewayEntry.ipv6Addr && JSON.parse(gatewayEntry.ipv6Addr)) || [];
    else
      this._discoveredGateway6 = [];
    if (this.o.gateway6 && !this._discoveredGateway6.includes(this.o.gateway6))
      this._discoveredGateway6.push(this.o.gateway6);

    this._monitoredGateway6 = this._monitoredGateway6 || [];
    if (_.isEqual(this._monitoredGateway6.sort(), this._discoveredGateway6.sort()))
      return;
    if (!this.o.gateway6 || !_.isArray(this.o.dns) || !this.o.dns.includes(this.o.gateway))
      // do not bother if ipv6 default route is not set or gateway ipv4 is not DNS server
      return;
    if (await Mode.isSpoofModeOn()) {
      // discovered new gateway IPv6 addresses and router also acts as dns, re-apply policy
      log.info(`New gateway IPv6 addresses are discovered, re-applying policy on ${this.o.uuid} ${this.o.intf}`, this._discoveredGateway6);
      this.scheduleApplyPolicy();
    }
  }

  async setPolicy(name, data) {
    this._policy[name] = data;
    await this.savePolicy();
    if (this.subscriber) {
      this.subscriber.publish("DiscoveryEvent", "NetworkPolicy:Changed", this.o.uuid, {name, data});
    }
  }

  async applyPolicy() {
    if (this.o.monitoring !== true) {
      log.info(`Network ${this.o.uuid} ${this.o.intf} does not require monitoring, skip apply policy`);
      return;
    }
    await this.loadPolicy();
    const policy = JSON.parse(JSON.stringify(this._policy));
    await pm.executeAsync(this, this.o.uuid, policy);
  }

  _getPolicyKey() {
    return `policy:network:${this.o.uuid}`;
  }

  async savePolicy() {
    const key = this._getPolicyKey();
    const policyObj = {};
    for (let k in this._policy) {
      policyObj[k] = JSON.stringify(this._policy[k]);
    }
    await rclient.hmsetAsync(key, policyObj).catch((err) => {
      log.error(`Failed to save policy to ${key}`, err);
    });
  }

  async loadPolicy() {
    const key = this._getPolicyKey();
    const policyData = await rclient.hgetallAsync(key);
    if (policyData) {
      this._policy = {};
      for (let k in policyData) {
        this._policy[k] = JSON.parse(policyData[k]);
      }
    } else {
      this._policy = {};
    }
    return this._policy;
  }

  // This actually incidates monitoring state. Old glossary used in PolicyManager.js
  async spoof(state) {
    const spoofModeOn = await Mode.isSpoofModeOn();
    const sm = new SpooferManager();
    if (state === true) {
      const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF} ${netIpsetName}`).catch((err) => {
        log.error(`Failed to remove ${netIpsetName} from ${ipset.CONSTANTS.IPSET_MONITORING_OFF}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF} ${netIpsetName6}`).catch((err) => {
        log.error(`Failed to remove ${netIpsetName6} from ${ipset.CONSTANTS.IPSET_MONITORING_OFF}`, err.message);
      });
      if (spoofModeOn && this.o.type === "wan") { // only spoof on wan interface
        if (this.o.gateway  && this.o.gateway.length > 0 
          && this.o.ipv4 && this.o.ipv4.length > 0
          && this.o.gateway !== this.o.ipv4) {
          await sm.registerSpoofInstance(this.o.intf, this.o.gateway, this.o.ipv4, false);
        }
        if (this.o.gateway6 && this.o.gateway6.length > 0 
          && this.o.ipv6 && this.o.ipv6.length > 0 
          && !this.o.ipv6.includes(this.o.gateway6)) {
            let updatedGateway6 = [];
            if (!_.isArray(this.o.dns) || !this.o.dns.includes(this.o.gateway)) {
              updatedGateway6 = [this.o.gateway6];
            } else {
              updatedGateway6 = this._discoveredGateway6 || [this.o.gateway6];
              log.info(`Router also acts as DNS server, spoof all its IPv6 addresses`, updatedGateway6);
            }
            this._monitoredGateway6 = this._monitoredGateway6 || [];
            const removedGateway6 = this._monitoredGateway6.filter(i => !updatedGateway6.includes(i));
            for (let gip of removedGateway6) {
              log.info(`Disable IPv6 spoof instance on ${gip}, ${this.o.uuid} ${this.o.intf}`);
              await sm.deregisterSpoofInstance(this.o.intf, gip, true);
            }
            for (let gip of updatedGateway6) {
              log.info(`Enable IPv6 spoof instance on ${gip}, ${this.o.uuid} ${this.o.intf}`);
              await sm.registerSpoofInstance(this.o.intf, gip, this.o.ipv6[0], true);
            }
            this._monitoredGateway6 = updatedGateway6;
        }
      }
    } else {
      const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
      const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF} ${netIpsetName}`).catch((err) => {
        log.error(`Failed to add ${netIpsetName} to ${ipset.CONSTANTS.IPSET_MONITORING_OFF}`, err.message);
      });
      await exec(`sudo ipset add -! ${ipset.CONSTANTS.IPSET_MONITORING_OFF} ${netIpsetName6}`).catch((err) => {
        log.error(`Failed to add ${netIpsetName6} to ${ipset.CONSTANTS.IPSET_MONITORING_OFF}`, err.message);
      });
      if (spoofModeOn && this.o.type === "wan") { // only spoof on wan interface
        if (this.o.gateway) {
          await sm.deregisterSpoofInstance(this.o.intf, "*", false);
        }
        if (this.o.gateway6 && this.o.gateway6.length > 0) {
          await sm.deregisterSpoofInstance(this.o.intf, "*", true);
          this._monitoredGateway6 = [];
        }
      }
    }
  }

  async vpnClient(policy) {
    // only support IPv4 now
    try {
      const state = policy.state;
      const profileId = policy.profileId;
      if (!profileId) {
        log.warn(`VPN client profileId is not specified for ${this.o.uuid} ${this.o.intf}`);
        return false;
      }
      const ovpnClient = new OpenVPNClient({profileId: profileId});
      const intf = ovpnClient.getInterfaceName();
      const rtId = await vpnClientEnforcer.getRtId(intf);
      if (!rtId)
        return false;
      const rtIdHex = Number(rtId).toString(16);
      if (state === true) {
        // set skbmark
        await exec(`sudo ipset -! del c_vpn_client_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)}`);
        await exec(`sudo ipset -! add c_vpn_client_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)} skbmark 0x${rtIdHex}/0xffff`);
      }
      // null means off
      if (state === null) {
        // reset skbmark
        await exec(`sudo ipset -! del c_vpn_client_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)}`);
        await exec(`sudo ipset -! add c_vpn_client_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)} skbmark 0x0000/0xffff`);
      }
      // false means N/A
      if (state === false) {
        // do not change skbmark
        await exec(`sudo ipset -! del c_vpn_client_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)}`);
      }
      return true;
    } catch (err) {
      log.error(`Failed to set VPN client access on network ${this.o.uuid} ${this.o.intf}`);
      return false;
    }
  }

  async shield(policy) {
  }

  // underscore prefix? follow same function name in Host.js :(
  async _dnsmasq(policy) {
    const dnsCaching = policy.dnsCaching;
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get net ipset name for ${this.o.uuid} ${this.o.intf}`);
      return;
    }
    if (dnsCaching === true) {
      let cmd =  `sudo ipset del -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${netIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${netIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset del -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${netIpsetName6}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${netIpsetName6} ${this.o.intf}`, err);
      });
    } else {
      let cmd =  `sudo ipset add -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${netIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${netIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset add -! ${ipset.CONSTANTS.IPSET_NO_DNS_BOOST} ${netIpsetName6}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${netIpsetName6} ${this.o.intf}`, err);
      });
    }
  }

  static getNetIpsetName(uuid, af = 4) {
    // TODO: need find a better way to get a unique name from uuid
    if (uuid) {
      return `c_net_${uuid.substring(0, 13)}_set` + (af === 4 ? "" : "6");
    } else
      return null;
  }

  static getRouteIpsetName(uuid, af = 4) {
    if (uuid) {
      return `c_route_${uuid.substring(0, 13)}_set` + (af === 4 ? "": "6");
    } else
      return null;
  }

  static getDnsmasqConfigDirectory(uuid) {
    if (uuid) {
      return `${f.getUserConfigFolder()}/dnsmasq/${uuid}/`;
    } else
      return null;
  }

  // This function can be called while enforcing rules on network.
  // In case the network doesn't exist at the time when policy is enforced, but may be restored from config history in future.
  // Thereby, the rule can still be applied and take effect once the network is restored
  static async ensureCreateEnforcementEnv(uuid) {
    if (envCreatedMap[uuid])
      return;
    const netIpsetName = NetworkProfile.getNetIpsetName(uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for ${uuid}`);
    } else {
      await exec(`sudo ipset create -! ${netIpsetName} hash:net,iface maxelem 1024`).catch((err) => {
        log.error(`Failed to create network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset create -! ${netIpsetName6} hash:net,iface family inet6 maxelem 1024`).catch((err) => {
        log.error(`Failed to create network profile ipset ${netIpsetName6}`, err.message);
      });
    }
    // routing ipset with skbmark extensions
    const routeIpsetName = NetworkProfile.getRouteIpsetName(uuid);
    const routeIpsetName6 = NetworkProfile.getRouteIpsetName(uuid, 6);
    if (!routeIpsetName || !routeIpsetName6) {
      log.error(`Failed to get route ipset name for ${uuid}`);
    } else {
      await exec(`sudo ipset create -! ${routeIpsetName} hash:net maxelem 10 skbinfo`).catch((err) => {
        log.error(`Failed to create network profile routing ipset ${routeIpsetName}`, err.message);
      });
      await exec(`sudo ipset create -! ${routeIpsetName6} hash:net family inet6 maxelem 10 skbinfo`).catch((err) => {
        log.error(`Failed to create network profile ipset ${routeIpsetName6}`, err.message);
      });
    }
    // ensure existence of dnsmasq per-network config directory
    if (uuid) {
      await exec(`mkdir -p ${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/`).catch((err) => {
        log.error(`Failed to create dnsmasq config directory for ${uuid}`);
      });
    }
    envCreatedMap[uuid] = 1;
  }

async createEnv() {
    // create and populate related ipsets
    await NetworkProfile.ensureCreateEnforcementEnv(this.o.uuid);
    let realIntf = this.o.intf;
    if (realIntf && realIntf.endsWith(":0"))
      realIntf = realIntf.substring(0, realIntf.length - 2);
    const inputRule = new Rule().chn("FW_INPUT_DROP").pro("tcp").mth(realIntf, null, "iif").mdl("conntrack", "--ctstate NEW").mdl("conntrack", "! --ctstate DNAT").jmp("FW_DROP").mdl("comment", `--comment ${this.o.uuid}`);
    const inputRule6 = inputRule.clone().fam(6);
    if (this.o.type === "wan" && await Mode.isRouterModeOn()) {
      // add DROP rule on WAN interface in router mode
      await exec(inputRule.toCmd("-A")).catch((err) => {
        log.error(`Failed to add IPv4 DROP rule to INPUT for WAN interface ${realIntf}`, err.message);
      });
      await exec(inputRule6.toCmd("-A")).catch((err) => {
        log.error(`Failed to add IPv6 DROP rule to INPUT for WAN interface ${realIntf}`, err.message);
      });
    } else {
      await exec(inputRule.toCmd("-D")).catch((err) => {});
      await exec(inputRule6.toCmd("-D")).catch((err) => {});
    }
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset flush -! ${netIpsetName}`).then(() => {
        if (this.o && this.o.monitoring === true && this.o.ipv4Subnet && this.o.ipv4Subnet.length != 0)
          return exec(`sudo ipset add -! ${netIpsetName} ${this.o.ipv4Subnet},${realIntf}`);
      }).catch((err) => {
        log.error(`Failed to populate network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset flush -! ${netIpsetName6}`).then(async () => {
        if (this.o && this.o.monitoring === true && this.o.ipv6Subnets && this.o.ipv6Subnets.length != 0) {
          for (const subnet6 of this.o.ipv6Subnets)
            await exec(`sudo ipset add -! ${netIpsetName6} ${subnet6},${realIntf}`).catch((err) => {});
        }
      }).catch((err) => {
        log.error(`Failed to populate network profile ipset ${netIpsetName6}`, err.message);
      });
      // add to c_lan_set accordingly, some feature has mandatory to be enabled on lan only, e.g., vpn client
      let op = "del"
      if (this.o.type === "lan" && this.o.monitoring === true)
        op = "add"
      await exec(`sudo ipset ${op} -! c_lan_set ${netIpsetName}`).then(() => {
        return exec(`sudo ipset ${op} -! c_lan_set ${netIpsetName6}`);
      }).catch((err) => {
        log.error(`Failed to ${op} ${netIpsetName}(6) to c_lan_set`, err.message);
      });
      // add to NAT hairpin chain if it is LAN network
      if (this.o.ipv4Subnet && this.o.ipv4Subnet.length != 0) {
        const rule = new Rule("nat").chn("FW_POSTROUTING_HAIRPIN").mth(`${this.o.ipv4Subnet}`, null, "src").jmp("MASQUERADE");
        if (this.o.type === "lan" && this.o.monitoring === true) {
          await exec(rule.toCmd('-A')).catch((err) => {
            log.error(`Failed to add NAT hairpin rule for ${this.o.intf}, ${this.o.uuid}`);
          });
        } else {
          await exec(rule.toCmd('-D')).catch((err) => {});
        }
      }
      // add to monitored net ipset accordingly
      op = "del";
      if (this.o.monitoring === true)
        op = "add";
      await exec(`sudo ipset ${op} -! ${ipset.CONSTANTS.IPSET_MONITORED_NET} ${netIpsetName}`).then(() => {
        return exec(`sudo ipset ${op} -! ${ipset.CONSTANTS.IPSET_MONITORED_NET} ${netIpsetName6}`);
      }).catch((err) => {
        log.error(`Failed to ${op} ${netIpsetName}(6) to ${ipset.CONSTANTS.IPSET_MONITORED_NET}`, err.message);
      });
    }

    const routeIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid);
    const routeIpsetName6 = NetworkProfile.getRouteIpsetName(this.o.uuid, 6);
    if (!routeIpsetName || !routeIpsetName6) {
      log.error(`Failed to get route ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset flush -! ${routeIpsetName}`).catch((err) => {});
      await exec(`sudo ipset flush -! ${routeIpsetName6}`).catch((err) => {});
      if (this.o.type === "wan") {
        const rtIdHex = Number(this.o.rtid).toString(16);
        // since hash:net does not allow /0 as cidr subnet, need to add two complementary entries to the ipset
        if (this.o.gateway) {
          await exec(`sudo ipset add -! ${routeIpsetName} 0.0.0.0/1 skbmark 0x${rtIdHex}/0xffff`).catch((err) => {
            log.error(`Failed to add 0.0.0.0/1 skbmark 0x${rtIdHex}/0xffff to ${routeIpsetName}`, err.message);
          });
          await exec(`sudo ipset add -! ${routeIpsetName} 128.0.0.0/1 skbmark 0x${rtIdHex}/0xffff`).catch((err) => {
            log.error(`Failed to add 128.0.0.0/1 skbmark 0x${rtIdHex}/0xffff to ${routeIpsetName}`, err.message);
          });
        }
        if (this.o.gateway6) {
          await exec(`sudo ipset add -! ${routeIpsetName6} ::/1 skbmark 0x${rtIdHex}/0xffff`).catch((err) => {
            log.error(`Failed to add ::/1 skbmark 0x${rtIdHex}/0xffff to ${routeIpsetName6}`, err.message);
          });
          await exec(`sudo ipset add -! ${routeIpsetName6} 8000::/1 skbmark 0x${rtIdHex}/0xffff`).catch((err) => {
            log.error(`Failed to add 8000::/1 skbmark 0x${rtIdHex}/0xffff to ${routeIpsetName6}`, err.message);
          });
        }
      }
    }
  }

  async destroyEnv() {
    let realIntf = this.o.intf;
    if (realIntf && realIntf.endsWith(":0"))
      realIntf = realIntf.substring(0, realIntf.length - 2);
    // remove WAN INPUT protection rules
    const inputRule = new Rule().chn("FW_INPUT_DROP").pro("tcp").mth(realIntf, null, "iif").mdl("conntrack", "--ctstate NEW").mdl("conntrack", "! --ctstate DNAT").jmp("FW_DROP").mdl("comment", `--comment ${this.o.uuid}`);
    const inputRule6 = inputRule.clone().fam(6);
    await exec(inputRule.toCmd("-D")).catch((err) => {});
    await exec(inputRule6.toCmd("-D")).catch((err) => {});

    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset flush -! ${netIpsetName}`).catch((err) => {
        log.debug(`Failed to flush network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset flush -! ${netIpsetName6}`).catch((err) => {
        log.debug(`Failed to flush network profile ipset ${netIpsetName6}`, err.message);
      });
      // although net ipset is already flushed, still remove it from c_lan_set anyway to keep consistency
      await exec(`sudo ipset del -! c_lan_set ${netIpsetName}`).catch((err) => {
        log.debug(`Failed to remove ${netIpsetName} from c_lan_set`, err.message);
      });
      await exec(`sudo ipset del -! c_lan_set ${netIpsetName6}`).catch((err) => {
        log.debug(`Failed to remove ${netIpsetName6} from c_lan_set`, err.message);
      });
      // remove from NAT hairpin chain anyway
      if (this.o.ipv4Subnet && this.o.ipv4Subnet.length != 0) {
        const rule = new Rule("nat").chn("FW_POSTROUTING_HAIRPIN").mth(`${this.o.ipv4Subnet}`, null, "src").jmp("MASQUERADE");
        await exec(rule.toCmd('-D')).catch((err) => {});
      }
      // still remove it from monitored net set anyway to keep consistency
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_MONITORED_NET} ${netIpsetName}`).catch((err) => {
        log.debug(`Failed to remove ${netIpsetName} from ${ipset.CONSTANTS.IPSET_MONITORED_NET}`, err.message);
      });
      await exec(`sudo ipset del -! ${ipset.CONSTANTS.IPSET_MONITORED_NET} ${netIpsetName6}`).catch((err) => {
        log.debug(`Failed to remove ${netIpsetName6} from ${ipset.CONSTANTS.IPSET_MONITORED_NET}`, err.message);
      });
      // do not touch dnsmasq network config directory here, it should only be updated by rule enforcement modules
    }

    const routeIpsetName = NetworkProfile.getRouteIpsetName(this.o.uuid);
    const routeIpsetName6 = NetworkProfile.getRouteIpsetName(this.o.uuid, 6);
    if (!routeIpsetName || !routeIpsetName6) {
      log.error(`Failed to get route ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset flush -! ${routeIpsetName}`).catch((err) => {
        log.debug(`Failed to flush network profile route ipset ${routeIpsetName}`, err.message);
      });
      await exec(`sudo ipset flush -! ${routeIpsetName6}`).catch((err) => {
        log.debug(`Failed to flush network profile route ipset ${routeIpsetName6}`, err.message);
      });
    }
    this.oper = null; // clear oper cache used in PolicyManager.js
    // disable spoof instances
    const sm = new SpooferManager();
    // use wildcard to deregister all spoof instances on this interface
    if (this.o.gateway) {
      await sm.deregisterSpoofInstance(this.o.intf, "*", false);
    }
    if (this.o.gateway6 && this.o.gateway6.length > 0) {
      await sm.deregisterSpoofInstance(this.o.intf, "*", true);
      this._monitoredGateway6 = [];
    }
    await sm.emptySpoofSet(this.o.intf);
  }
  
  getTags() {
    if (_.isEmpty(this._tags)) {
      return []; 
    }

    return this._tags;
  }

  async tags(tags) {
    tags = tags || [];
    this._tags = this._tags || [];
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    const netIpsetName6 = NetworkProfile.getNetIpsetName(this.o.uuid, 6);
    if (!netIpsetName || !netIpsetName6) {
      log.error(`Failed to get ipset name for network profile ${this.o.uuid}`);
      return;
    }
    // remove old tags that are not in updated tags
    const removedTags = this._tags.filter(uid => !(tags.includes(Number(uid)) || tags.includes(String(uid))));
    for (let removedTag of removedTags) {
      const tag = TagManager.getTagByUid(removedTag);
      if (tag) {
        await exec(`sudo ipset del -! ${Tag.getTagSetName(removedTag)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset del -! ${Tag.getTagSetName(removedTag)} ${netIpsetName6}`);
        }).catch((err) => {
          log.error(`Failed to remove ${netIpsetName}(6) from ${Tag.getTagSetName(removedTag)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        await exec(`sudo ipset del -! ${Tag.getTagNetSetName(removedTag)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset del -! ${Tag.getTagNetSetName(removedTag)} ${netIpsetName6}`);
        }).catch((err) => {
          log.error(`Failed to remove ${netIpsetName}(6) from ${Tag.getTagNetSetName(removedTag)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        await fs.unlinkAsync(`${NetworkProfile.getDnsmasqConfigDirectory(this.o.uuid)}/tag_${removedTag}_${this.o.uuid}.conf`).catch((err) => {});
      } else {
        log.warn(`Tag ${removedTag} not found`);
      }
    }
    // filter updated tags in case some tag is already deleted from system
    const updatedTags = [];
    for (let uid of tags) {
      const tag = TagManager.getTagByUid(uid);
      if (tag) {
        await exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset add -! ${Tag.getTagSetName(uid)} ${netIpsetName6}`);
        }).catch((err) => {
          log.error(`Failed to add ${netIpsetName}(6) to ${Tag.getTagSetName(uid)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        await exec(`sudo ipset add -! ${Tag.getTagNetSetName(uid)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset add -! ${Tag.getTagNetSetName(uid)} ${netIpsetName6}`);
        }).catch((err) => {
          log.error(`Failed to add ${netIpsetName}(6) to ${Tag.getTagNetSetName(uid)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        const dnsmasqEntry = `mac-address-group=%00:00:00:00:00:00@${uid}`;
        await fs.writeFileAsync(`${NetworkProfile.getDnsmasqConfigDirectory(this.o.uuid)}/tag_${uid}_${this.o.uuid}.conf`, dnsmasqEntry).catch((err) => {
          log.error(`Failed to write dnsmasq tag ${uid} ${tag.o.name} on network ${this.o.uuid} ${this.o.intf}`, err);
        })
        updatedTags.push(uid);
      } else {
        log.warn(`Tag ${uid} not found`);
      }
    }
    this._tags = updatedTags;
    await this.setPolicy("tags", this._tags); // keep tags in policy data up-to-date
    dnsmasq.scheduleRestartDNSService();
  }
}

module.exports = NetworkProfile;