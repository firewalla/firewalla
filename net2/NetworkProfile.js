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
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const Dnsmasq = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new Dnsmasq();

class NetworkProfile {
  constructor(o) {
    this.o = o;
    this._policy = {};
    const c = require('./MessageBus.js');
    this.subscriber = new c("info");
    if (f.isMain()) {
      if (o && o.uuid) {
        this.subscriber.subscribeOnce("DiscoveryEvent", "NetworkPolicy:Changed", this.o.uuid, (channel, type, id, obj) => {
          log.info(`Network policy is changed on ${this.o.intf}, uuid: ${this.o.uuid}`, obj);
          this.applyPolicy();
        })
      }
    }
    return this;
  }

  update(o) {
    this.o = o;
  }

  toJson() {
    const json = Object.assign({}, this.o, {policy: this._policy});
    return json;
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
    if (state === true) {
      await iptables.switchInterfaceMonitoringAsync(true, this.o.intf);
      await ip6tables.switchInterfaceMonitoringAsync(true, this.o.intf);
    } else {
      await iptables.switchInterfaceMonitoringAsync(false, this.o.intf);
      await ip6tables.switchInterfaceMonitoringAsync(false, this.o.intf);
    }
    // TODO: not finished yet. Need to start/stop spoof instance on the interface
  }

  async vpnClient(policy) {

  }

  async shield(policy) {

  }

  // underscore prefix? follow same function name in Host.js :(
  async _dnsmasq(policy) {
    const dnsCaching = policy.dnsCaching;
    if (dnsCaching === true) {
      
    } else {

    }
  }

  static getNetIpsetName(uuid) {
    const networkProfile = require('./NetworkProfileManager.js').getNetworkProfile(uuid);
    if (networkProfile) {
      const iface = networkProfile.o.intf;
      if (!iface || iface.length == 0) {
        log.error(`Failed to get interface name of network ${uuid}`);
        return null;
      }
      return `c_net_${networkProfile.o.intf}_set`;
    } else {
      log.warn(`Network ${uuid} not found`);
      return null;
    }
  }

  async createEnv() {
    // create related ipsets
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    if (!netIpsetName) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset create -! ${netIpsetName} hash:net,iface maxelem 1024`).then(() => {
        return exec(`sudo ipset flush -! ${netIpsetName}`);
      }).then(() => {
        if (this.o && this.o.ipv4 && this.o.ipv4.length != 0)
          return exec(`sudo ipset add -! ${netIpsetName} ${this.o.ipv4},${this.o.intf}`);
      }).catch((err) => {
        log.error(`Failed to create network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset create -! ${netIpsetName}6 hash:net,iface family inet6 maxelem 1024`).then(() => {
        // TODO: add ipv6 prefixes to ipset
      }).catch((err) => {
        log.error(`Failed to create network profile ipset ${netIpsetName}6`, err.message);
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
      // delete related dnsmasq config files
      if (this.o.intf)
        await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/${this.o.intf}/*`).catch((err) => {});
    }
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
          log.error(`Failed to delete tag ${removedTag} ${tag.o.name} on network ${this.o.uuid} ${this.o.intf}`, err);
        });
        await fs.unlinkAsync(`${f.getUserConfigFolder()}/dnsmasq/${this.o.intf}/tag_${removedTag}_${this.o.intf}.conf`).catch((err) => {});
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
          log.error(`Failed to add tag ${uid} ${tag.o.name} on network ${this.o.uuid} ${this.o.intf}`, err);
        });
        const dnsmasqEntry = `mac-address-group=%00:00:00:00:00:00@${uid}`;
        await fs.writeFileAsync(`${f.getUserConfigFolder()}/dnsmasq/${this.o.intf}/tag_${uid}_${this.o.intf}.conf`, dnsmasqEntry).catch((err) => {
          log.error(`Failed to write dnsmasq tag ${uid} ${tag.o.name} on network ${this.o.uuid} ${this.o.intf}`, err);
        })
        updatedTags.push(uid);
      } else {
        log.warn(`Tag ${uid} not found`);
      }
    }
    this._tags = updatedTags;
    this.setPolicy("tags", this._tags); // keep tags in policy data up-to-date
    await dnsmasq.restartDnsmasq();
  }
}

module.exports = NetworkProfile;