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
const iptables = require('./Iptables.js');
const ip6tables = require('./Ip6tables.js');
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
    if (this.reapplyTask)
      clearTimeout(this.reapplyTask);
    this.reapplyTask = setTimeout(() => {
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
    if (Mode.isSpoofModeOn()) {
      // discovered new gateway IPv6 addresses and router also acts as dns, re-apply policy
      log.info(`New gateway IPv6 addresses are discovered, re-applying policy on ${this.o.uuid} ${this.o.intf}`, this._discoveredGateway6);
      this.scheduleApplyPolicy();
    }
  }

  async setPolicy(name, data) {
    this._policy[name] = data;
    await this.savePolicy();
    if (this.subscriber) {
      setTimeout(() => {
        this.subscriber.publish("DiscoveryEvent", "NetworkPolicy:Changed", this.o.uuid, {name, data});
      }, 2000); // 2 seconds buffer for concurrent policy data change to be persisted
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
      await iptables.switchInterfaceMonitoringAsync(true, this.o.intf);
      await ip6tables.switchInterfaceMonitoringAsync(true, this.o.intf);
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
      await iptables.switchInterfaceMonitoringAsync(false, this.o.intf);
      await ip6tables.switchInterfaceMonitoringAsync(false, this.o.intf);
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
        await exec(`sudo ipset -! del c_wan_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)}`);
        await exec(`sudo ipset -! add c_wan_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)} skbmark 0x${rtIdHex}/0xffff`);
      }
      if (state === false) {
        // reset skbmark
        await exec(`sudo ipset -! del c_wan_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)}`);
        await exec(`sudo ipset -! add c_wan_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)} skbmark 0x0000/0xffff`);
      }
      if (state === null) {
        // do not change skbmark
        await exec(`sudo ipset -! del c_wan_n_set ${NetworkProfile.getNetIpsetName(this.o.uuid)}`);
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
    if (!netIpsetName) {
      log.error(`Failed to get net ipset name for ${this.o.uuid} ${this.o.intf}`);
      return;
    }
    if (dnsCaching === true) {
      let cmd =  `sudo ipset del -! no_dns_caching_set ${netIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${netIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset del -! no_dns_caching_set ${netIpsetName}6`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${netIpsetName}6 ${this.o.intf}`, err);
      });
    } else {
      let cmd =  `sudo ipset add -! no_dns_caching_set ${netIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${netIpsetName} ${this.o.intf}`, err);
      });
      cmd = `sudo ipset add -! no_dns_caching_set ${netIpsetName}6`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${netIpsetName}6 ${this.o.intf}`, err);
      });
    }
  }

  static getNetIpsetName(uuid) {
    // TODO: need find a better way to get a unique name from uuid
    if (uuid) {
      return `c_net_${uuid.substring(0, 13)}_set`;
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
    const netIpsetName = NetworkProfile.getNetIpsetName(uuid);
    if (!netIpsetName) {
      log.error(`Failed to get ipset name for ${uuid}`);
    } else {
      await exec(`sudo ipset create -! ${netIpsetName} hash:net,iface maxelem 1024`).catch((err) => {
        log.error(`Failed to create network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset create -! ${netIpsetName}6 hash:net,iface family inet6 maxelem 1024`).catch((err) => {
        log.error(`Failed to create network profile ipset ${netIpsetName}6`, err.message);
      });
    }
    // ensure existence of dnsmasq per-network config directory
    if (uuid) {
      await exec(`mkdir -p ${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/`).catch((err) => {
        log.error(`Failed to create dnsmasq config directory for ${uuid}`);
      });
    }
  }

  async createEnv() {
    // create and populate related ipsets
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    if (!netIpsetName) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      await NetworkProfile.ensureCreateEnforcementEnv(this.o.uuid);
      let realIntf = this.o.intf;
      if (realIntf && realIntf.endsWith(":0"))
        realIntf = realIntf.substring(0, realIntf.length - 2);
      await exec(`sudo ipset flush -! ${netIpsetName}`).then(() => {
        if (this.o && this.o.ipv4Subnet && this.o.ipv4Subnet.length != 0)
          return exec(`sudo ipset add -! ${netIpsetName} ${this.o.ipv4Subnet},${realIntf}`);
      }).catch((err) => {
        log.error(`Failed to populate network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset flush -! ${netIpsetName}6`).then(async () => {
        if (this.o && this.o.ipv6Subnets && this.o.ipv6Subnets.length != 0) {
          for (const subnet6 of this.o.ipv6Subnets)
            await exec(`sudo ipset add -! ${netIpsetName}6 ${subnet6},${realIntf}`).catch((err) => {});
        }
      }).catch((err) => {
        log.error(`Failed to populate network profile ipset ${netIpsetName}6`, err.message);
      });
      // add to c_lan_set accordingly, some feature has mandatory to be enabled on lan only, e.g., vpn client
      let op = "del"
      if (this.o.type === "lan")
        op = "add"
      await exec(`sudo ipset ${op} -! c_lan_set ${netIpsetName}`).then(() => {
        return exec(`sudo ipset ${op} -! c_lan_set ${netIpsetName}6`);
      }).catch((err) => {
        log.error(`Failed to ${op} ${netIpsetName}(6) to c_lan_set`, err.message);
      });
    }
  }

  async destroyEnv() {
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    if (!netIpsetName) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset flush -! ${netIpsetName}`).then(() => {
      }).catch((err) => {
        log.error(`Failed to flush network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset flush -! ${netIpsetName}6`).then(() => {
      }).catch((err) => {
        log.error(`Failed to flush network profile ipset ${netIpsetName}6`, err.message);
      });
      // do not touch dnsmasq network config directory here, it should only be updated by rule enforcement modules
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
    if (!netIpsetName) {
      log.error(`Failed to get ipset name for network profile ${this.o.uuid}`);
      return;
    }
    // remove old tags that are not in updated tags
    const removedTags = this._tags.filter(uid => !(tags.includes(Number(uid)) || tags.includes(String(uid))));
    for (let removedTag of removedTags) {
      const tag = TagManager.getTagByUid(removedTag);
      if (tag) {
        await exec(`sudo ipset del -! ${Tag.getTagIpsetName(removedTag)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset del -! ${Tag.getTagIpsetName(removedTag)} ${netIpsetName}6`);
        }).catch((err) => {
          log.error(`Failed to remove ${netIpsetName}(6) from ${Tag.getTagIpsetName(removedTag)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        await exec(`sudo ipset del -! ${Tag.getTagNetIpsetName(removedTag)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset del -! ${Tag.getTagNetIpsetName(removedTag)} ${netIpsetName}6`);
        }).catch((err) => {
          log.error(`Failed to remove ${netIpsetName}(6) from ${Tag.getTagNetIpsetName(removedTag)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        await fs.unlinkAsync(`${NetworkProfile.getDnsmasqConfigDirectory(this.o.uuid)}/tag_${removedTag}_${this.o.intf}.conf`).catch((err) => {});
      } else {
        log.warn(`Tag ${removedTag} not found`);
      }
    }
    // filter updated tags in case some tag is already deleted from system
    const updatedTags = [];
    for (let uid of tags) {
      const tag = TagManager.getTagByUid(uid);
      if (tag) {
        await exec(`sudo ipset add -! ${Tag.getTagIpsetName(uid)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset add -! ${Tag.getTagIpsetName(uid)} ${netIpsetName}6`);
        }).catch((err) => {
          log.error(`Failed to add ${netIpsetName}(6) to ${Tag.getTagIpsetName(uid)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        await exec(`sudo ipset add -! ${Tag.getTagNetIpsetName(uid)} ${netIpsetName}`).then(() => {
          return exec(`sudo ipset add -! ${Tag.getTagNetIpsetName(uid)} ${netIpsetName}6`);
        }).catch((err) => {
          log.error(`Failed to add ${netIpsetName}(6) to ${Tag.getTagNetIpsetName(uid)}, ${this.o.uuid} ${this.o.intf}`, err);
        });
        const dnsmasqEntry = `mac-address-group=%00:00:00:00:00:00@${uid}`;
        await fs.writeFileAsync(`${NetworkProfile.getDnsmasqConfigDirectory(this.o.uuid)}/tag_${uid}_${this.o.intf}.conf`, dnsmasqEntry).catch((err) => {
          log.error(`Failed to write dnsmasq tag ${uid} ${tag.o.name} on network ${this.o.uuid} ${this.o.intf}`, err);
        })
        updatedTags.push(uid);
      } else {
        log.warn(`Tag ${uid} not found`);
      }
    }
    this._tags = updatedTags;
    await this.setPolicy("tags", this._tags); // keep tags in policy data up-to-date
    await dnsmasq.restartDnsmasq();
  }
}

module.exports = NetworkProfile;