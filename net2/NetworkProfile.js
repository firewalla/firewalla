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
const Mode = require('./Mode.js');
const SpooferManager = require('./SpooferManager.js');
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
            this.applyPolicy();
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
          await sm.registerSpoofInstance(this.o.intf, this.o.gateway6, this.o.ipv6[0], true);
          // TODO: spoof gateway's other ipv6 addresses if it is also dns server
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
        }
      }
    }
  }

  async vpnClient(policy) {

  }

  async shield(policy) {

  }

  // underscore prefix? follow same function name in Host.js :(
  async _dnsmasq(policy) {
    const dnsCaching = policy.dnsCaching;
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    if (!netIpsetName) {
      log.error(`Failed to get net ipset name for ${this.o.uuid} ${this.o.name}`);
      return;
    }
    if (dnsCaching === true) {
      let cmd =  `sudo ipset del -! no_dns_caching_set ${netIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${netIpsetName} ${this.o.name}`, err);
      });
      cmd = `sudo ipset del -! no_dns_caching_set ${netIpsetName}6`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to disable dns cache on ${netIpsetName}6 ${this.o.name}`, err);
      });
    } else {
      let cmd =  `sudo ipset add -! no_dns_caching_set ${netIpsetName}`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${netIpsetName} ${this.o.name}`, err);
      });
      cmd = `sudo ipset add -! no_dns_caching_set ${netIpsetName}6`;
      await exec(cmd).catch((err) => {
        log.error(`Failed to enable dns cache on ${netIpsetName}6 ${this.o.name}`, err);
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

  async createEnv() {
    // create related ipsets
    const netIpsetName = NetworkProfile.getNetIpsetName(this.o.uuid);
    if (!netIpsetName) {
      log.error(`Failed to get ipset name for ${this.o.uuid}`);
    } else {
      await exec(`sudo ipset create -! ${netIpsetName} hash:net,iface maxelem 1024`).then(() => {
        return exec(`sudo ipset flush -! ${netIpsetName}`);
      }).then(() => {
        if (this.o && this.o.ipv4Subnet && this.o.ipv4Subnet.length != 0)
          return exec(`sudo ipset add -! ${netIpsetName} ${this.o.ipv4Subnet},${this.o.intf}`);
      }).catch((err) => {
        log.error(`Failed to create network profile ipset ${netIpsetName}`, err.message);
      });
      await exec(`sudo ipset create -! ${netIpsetName}6 hash:net,iface family inet6 maxelem 1024`).then(async () => {
        if (this.o && this.o.ipv6Subnets && this.o.ipv6Subnets.length != 0) {
          for (const subnet6 of this.o.ipv6Subnets)
            await exec(`sudo ipset add -! ${netIpsetName}6 ${subnet6},${this.o.intf}`).catch((err) => {});
        }
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
    this.oper = null; // clear oper cache used in PolicyManager.js
    // disable spoof instances
    const sm = new SpooferManager();
    // use wildcard to deregister all spoof instances on this interface
    if (this.o.gateway) {
      await sm.deregisterSpoofInstance(this.o.intf, "*", false);
    }
    if (this.o.gateway6 && this.o.gateway6.length > 0) {
      await sm.deregisterSpoofInstance(this.o.intf, "*", true);
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
    await this.setPolicy("tags", this._tags); // keep tags in policy data up-to-date
    await dnsmasq.restartDnsmasq();
  }
}

module.exports = NetworkProfile;