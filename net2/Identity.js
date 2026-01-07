/*    Copyright 2021-2026 Firewalla Inc.
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
const sysManager = require('./SysManager.js');
const f = require('./Firewalla.js');
const exec = require('child-process-promise').exec;
const { Rule } = require('./Iptables.js');
const iptc = require('../control/IptablesControl.js');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const Ipset = require('./Ipset.js');
const VPNClient = require('../extension/vpnclient/VPNClient.js');
const VirtWanGroup = require('./VirtWanGroup.js');
const routing = require('../extension/routing/routing.js');
const Monitorable = require('./Monitorable');
const TagManager = require('./TagManager.js');

const _ = require('lodash');
const fs = require('fs');
const { Address4, Address6 } = require('ip-address');
const Tag = require('./Tag.js');
const Constants = require('./Constants.js');

const envCreatedMap = {};

class Identity extends Monitorable {
  constructor(o) {
    super(o)
    const instanceKey = this.getGUID()
    if (!Monitorable.instances[instanceKey]) {
      if (f.isMain()) {
        this.monitoring = false;
      }
      Monitorable.instances[instanceKey] = this;
      log.info('Created new Identity:', this.getGUID())
    }
    return Monitorable.instances[instanceKey];
  }

  static metaFieldsJson = [ 'activities' ]

  static isAddressInRedis() {
    // set this to false if address will not change dynamically, this can save CPU usage on redis
    return true;
  }

  getMetaKey() {
    return "identity:" + this.getGUID()
  }

  _getPolicyKey() {
    return `policy:${this.constructor.getNamespace()}:${this.getUniqueId()}`;
  }

  static getEnforcementIPsetName(uid, af = 4) {
    return `c_${this.getNamespace()}_${uid.substring(0, 12)}_set` + (af === 4 ? "" : "6");
  }

  static getEnforcementDnsmasqGroupId(uid) {
    return `${this.getNamespace()}_${uid}`;
  }

  static getRedisSetName(uid) {
    return `${this.getNamespace()}:addresses:${uid}`
  }

  getDnsmasqConfigDirectory() {
    return `${f.getUserConfigFolder()}/dnsmasq`
  }

  static getDnsmasqConfigFilenamePrefix(uid) {
    return `${this.getNamespace()}_${uid}`;
  }

  static async ensureCreateEnforcementEnv(uid) {
    const instanceKey = `${this.getNamespace()}:${uid}`
    if (envCreatedMap[instanceKey])
      return;
    // create related ipsets
    Ipset.create(this.getEnforcementIPsetName(uid), 'hash:net', false);
    Ipset.create(this.getEnforcementIPsetName(uid, 6), 'hash:net', true);
    envCreatedMap[instanceKey] = 1;
  }

  async createEnv() {
    const uid = this.getUniqueId();
    await this.constructor.ensureCreateEnforcementEnv(uid);
    if (this.constructor.isAddressInRedis()) {
      const content = `redis-src-address-group=%${this.constructor.getRedisSetName(uid)}@${this.constructor.getEnforcementDnsmasqGroupId(uid)}`;
      await fs.promises.writeFile(`${this.getDnsmasqConfigDirectory()}/${this.constructor.getDnsmasqConfigFilenamePrefix(uid)}.conf`, content, { encoding: 'utf8' }).catch((err) => {
        log.error(`Failed to create dnsmasq config for identity ${uid}`, err.message);
      });
      dnsmasq.scheduleRestartDNSService();
    }
  }

  async destroyEnv() {
    Ipset.flush(this.constructor.getEnforcementIPsetName(this.getUniqueId()));
    Ipset.flush(this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6));
    // delete related dnsmasq config files
    const uid = this.getUniqueId();
    await exec(`sudo rm -f ${this.getDnsmasqConfigDirectory()}/${this.constructor.getDnsmasqConfigFilenamePrefix(uid)}.conf`).catch((err) => { });
    await exec(`sudo rm -f ${this.getDnsmasqConfigDirectory()}/${this.constructor.getDnsmasqConfigFilenamePrefix(uid)}_*.conf`).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
    const redisKey = this.constructor.getRedisSetName(this.getUniqueId());
    await rclient.unlinkAsync(redisKey);
    delete this._ips;
  }

  async updateIPs(ips) {
    const redisKey = this.constructor.getRedisSetName(this.getUniqueId());
    if (this._ips && _.isEqual(ips.sort(), this._ips.sort())) {
      log.debug(`IP addresses of identity ${this.getUniqueId()} is not changed`, ips);
      return;
    }
    log.info(`IP addresses of identity ${this.getUniqueId()} is changed`, this._ips, ips);
    const tags = [];
    for (const type of Object.keys(Constants.TAG_TYPE_MAP)) {
      const typeTags = await this.getTags(type) || [];
      Array.prototype.push.apply(tags, typeTags);
    }
    if (_.isArray(this._ips)) {
      for (const ip of this._ips) {
        // remove old ips from tag ipset
        if (new Address4(ip).isValid()) {
          for (const uid of tags)
            Ipset.del(Tag.getTagDeviceIPSetName(uid, 4), ip);
        } else {
          if (new Address6(ip).isValid()) {
            for (const uid of tags)
              Ipset.del(Tag.getTagDeviceIPSetName(uid, 6), ip);
          }
        }
      }
    }
    const setName4 = this.constructor.getEnforcementIPsetName(this.getUniqueId());
    const setName6 = this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6);
    Ipset.flush(setName4);
    Ipset.flush(setName6);
    for (const ip of ips) {
      if (new Address4(ip).isValid()) {
        Ipset.add(setName4, ip);
        for (const uid of tags)
          Ipset.add(Tag.getTagDeviceIPSetName(uid, 4), ip, { timeout: 0 });
      } else {
        if (new Address6(ip).isValid()) {
          Ipset.add(setName6, ip);
          for (const uid of tags)
            Ipset.add(Tag.getTagDeviceIPSetName(uid, 6), ip, { timeout: 0 });
        }
      }
    }

    // update IP addresses in redis set
    // TODO: only supports IPv4 address here
    if (this.constructor.isAddressInRedis()) {
      const currentIPs = await rclient.smembersAsync(redisKey);
      const removedIPs = currentIPs.filter(ip => !ips.includes(ip)) || [];
      const newIPs = ips.filter(ip => !currentIPs.includes(ip)).map(ip => (ip.endsWith('/32') || ip.endsWith('/128')) ? ip.split('/')[0] : ip); // TODO: support cidr match in dnsmasq
      if (removedIPs.length > 0)
        await rclient.sremAsync(redisKey, removedIPs);
      if (newIPs.length > 0)
        await rclient.saddAsync(redisKey, newIPs);
    } else {
      const content = ips.map((ip) => `src-address-group=%${ip.endsWith('/32') || ip.endsWith('/128') ? ip.split('/')[0] : ip}@${this.constructor.getEnforcementDnsmasqGroupId(this.getUniqueId())}`).join('\n');
      await fs.promises.writeFile(`${this.getDnsmasqConfigDirectory()}/${this.constructor.getDnsmasqConfigFilenamePrefix(this.getUniqueId())}.conf`, content, { encoding: "utf8" }).catch((err) => {
        log.error(`Failed to update dnsmasq config for identity ${this.getUniqueId()}`, err.message);
      });
      dnsmasq.scheduleRestartDNSService();
    }
    this._ips = ips;
  }

  static isEnabled() {
    return true;
  }

  getUniqueId() { throw new Error('Not Implemented!') }

  getGUID() {
    return `${this.constructor.getNamespace()}:${this.getUniqueId()}`;
  }

  static getKeyOfUIDInAlarm() { }

  // return a string, length of which should not exceed 8
  static getNamespace() { throw new Error('Not Implemented!') }

  static getClassName() { return 'Identity' }

  static getKeyOfInitData() { throw new Error('Not Implemented!') }

  static async getInitData() {
    const json = {};
    const identities = await this.getIdentities();
    await Promise.all(Object.keys(identities).map(async uid => {
      await identities[uid].loadPolicyAsync();
      json[uid] = identities[uid].toJson();
    }));
    return json;
  }

  // return an object, key is uid, value is an Idendity object
  static async getIdentities() {
    return {};
  }

  // return an object, key is IP address, value is uid
  static async getIPUniqueIdMappings() {
    return {};
  }

  // return an object, key is IP address, value is IP:port of the endpoint. This is usually applicable on tunnelled identity
  static async getIPEndpointMappings() {
    return {};
  }

  // getIdentities will be invoked if any of these events is triggered
  static getRefreshIdentitiesHookEvents() {
    return [];
  }

  // getIPUniqueIdMappings will be invoked if any of these events is triggered
  static getRefreshIPMappingsHookEvents() {
    return [];
  }

  getReadableName() {
    return this.getUniqueId();
  }

  getLocalizedNotificationKeySuffix() {
    return "";
  }

  getDeviceNameInNotificationContent(alarm) {
    return alarm["p.device.name"];
  }

  getNicName() {

  }

  getNicUUID() {
    const nic = this.getNicName();
    if (nic) {
      const intf = sysManager.getInterface(nic);
      return intf && intf.uuid;
    }
    return null;
  }

  async tags(tags, type = Constants.TAG_TYPE_GROUP) {
    const policyKey = _.get(Constants.TAG_TYPE_MAP, [type, "policyKey"]);
    if (!policyKey) {
      log.error(`Unknown tag type ${type}, ignore tags`, tags);
      return;
    }
    tags = (tags || []).map(String);
    this[`_${policyKey}`] = this[`_${policyKey}`] || [];
    const ips = this.getIPs();
    // remove old tags that are not in updated tags
    const removedUids = this[`_${policyKey}`].filter(uid => !tags.includes(uid));
    for (let removedUid of removedUids) {
      const tagExists = await TagManager.tagUidExists(removedUid, type);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(removedUid);
        for (const ip of ips) {
          if (new Address4(ip).isValid()) {
            Ipset.del(Tag.getTagDeviceIPSetName(removedUid, 4), ip);
          } else {
            if (new Address6(ip).isValid()) {
              Ipset.del(Tag.getTagDeviceIPSetName(removedUid, 6), ip);
            }
          }
        }
        Ipset.del(Tag.getTagDeviceSetName(removedUid), this.constructor.getEnforcementIPsetName(this.getUniqueId()));
        Ipset.del(Tag.getTagDeviceSetName(removedUid), this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6));
        await fs.promises.unlink(`${this.getDnsmasqConfigDirectory()}/tag_${removedUid}_${this.constructor.getDnsmasqConfigFilenamePrefix(this.getUniqueId())}.conf`).catch((err) => {});
      } else {
        log.warn(`Tag ${removedUid} not found`);
      }
    }
    const updatedTags = [];
    for (const tagUid of tags) {
      const tagExists = await TagManager.tagUidExists(tagUid, type);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(tagUid);
        for (const ip of ips) {
          if (new Address4(ip).isValid()) {
            Ipset.add(Tag.getTagDeviceIPSetName(tagUid, 4), ip, { timeout: 0 });
          } else {
            if (new Address6(ip).isValid()) {
              Ipset.add(Tag.getTagDeviceIPSetName(tagUid, 6), ip, { timeout: 0 });
            }
          }
        }
        Ipset.add(Tag.getTagDeviceSetName(tagUid), this.constructor.getEnforcementIPsetName(this.getUniqueId()));
        Ipset.add(Tag.getTagDeviceSetName(tagUid), this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6));
        const dnsmasqEntry = `group-group=@${this.constructor.getEnforcementDnsmasqGroupId(this.getUniqueId())}@${tagUid}`;
        await fs.promises.writeFile(`${this.getDnsmasqConfigDirectory()}/tag_${tagUid}_${this.constructor.getDnsmasqConfigFilenamePrefix(this.getUniqueId())}.conf`, dnsmasqEntry).catch((err) => {
          log.error(`Failed to write dnsmasq tag ${tagUid} on ${this.getGUID()}`, err);
        });
        updatedTags.push(tagUid);
      } else {
        log.warn(`Tag ${tagUid} not found`);
      }
    }
    this[`_${policyKey}`] = updatedTags;
    await this.setPolicyAsync(policyKey, this[`_${policyKey}`]); // keep tags in policy data up-to-date
    dnsmasq.scheduleRestartDNSService();
  }

  async spoof(state) {
    this.monitoring = state;
  }

  isMonitoring() {
    return this.monitoring;
  }

  async qos(policy) {
    let state = true;
    switch (typeof policy) {
      case "boolean":
        state = policy;
        break;
      case "object":
        state = policy.state;
    }
    const identityIpsetName = this.constructor.getEnforcementIPsetName(this.getUniqueId());
    const identityIpsetName6 = this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6);
    if (state === true) {
      Ipset.del(Ipset.CONSTANTS.IPSET_QOS_OFF, identityIpsetName);
      Ipset.del(Ipset.CONSTANTS.IPSET_QOS_OFF, identityIpsetName6);
    } else {
      Ipset.add(Ipset.CONSTANTS.IPSET_QOS_OFF, identityIpsetName);
      Ipset.add(Ipset.CONSTANTS.IPSET_QOS_OFF, identityIpsetName6);
    }
  }

  async acl(state) {
    const identityIpsetName = this.constructor.getEnforcementIPsetName(this.getUniqueId());
    const identityIpsetName6 = this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6);
    if (state === true) {
      Ipset.del(Ipset.CONSTANTS.IPSET_ACL_OFF, identityIpsetName);
      Ipset.del(Ipset.CONSTANTS.IPSET_ACL_OFF, identityIpsetName6);
    } else {
      Ipset.add(Ipset.CONSTANTS.IPSET_ACL_OFF, identityIpsetName);
      Ipset.add(Ipset.CONSTANTS.IPSET_ACL_OFF, identityIpsetName6);
    }
  }

  async vpnClient(policy) {
    try {
      const state = policy.state;
      const profileId = policy.profileId;
      const idConfPath = `${this.getDnsmasqConfigDirectory()}/${this.constructor.getDnsmasqConfigFilenamePrefix(this.getUniqueId())}_vc.conf`;
      if (this._profileId && profileId !== this._profileId) {
        log.info(`Current VPN profile id id different from the previous profile id ${this._profileId}, remove old rule on identity ${this.getUniqueId()}`);
        const rule = new Rule("mangle").chn("FW_RT_TAG_DEVICE_5")
          .jmp(`SET --map-set ${this._profileId.startsWith("VWG:") ? VirtWanGroup.getRouteIpsetName(this._profileId.substring(4)) : VPNClient.getRouteIpsetName(this._profileId)} dst,dst --map-mark`)
          .comment(this._getPolicyKey());
        const rule4 = rule.clone().mdl("set", `--match-set ${this.constructor.getEnforcementIPsetName(this.getUniqueId())} src`);
        const rule6 = rule.clone().mdl("set", `--match-set ${this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6)} src`).fam(6);
        iptc.addRule(rule4.opr('-D'));
        iptc.addRule(rule6.opr('-D'));

        // remove rule that was set by state == null
        iptc.addRule(rule4.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`).opr('-D'));
        iptc.addRule(rule6.jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`).opr('-D'));
        const vcConfPath = this._profileId.startsWith("VWG:") ? `${VirtWanGroup.getDNSRouteConfDir(this._profileId.substring(4), "hard")}/${this.constructor.getDnsmasqConfigFilenamePrefix(this.getUniqueId())}_vc.conf` : `${VPNClient.getDNSRouteConfDir(this._profileId, "hard")}/${this.constructor.getDnsmasqConfigFilenamePrefix(this.getUniqueId())}_vc.conf`;
        await fs.promises.unlink(idConfPath).catch((err) => {});
        await fs.promises.unlink(vcConfPath).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }

      this._profileId = profileId;
      if (!profileId) {
        log.verbose("VPN client profileId is not specified for " + this.getUniqueId());
        return;
      }
      const rule = new Rule("mangle").chn("FW_RT_TAG_DEVICE_5")
        .jmp(`SET --map-set ${profileId.startsWith("VWG:") ? VirtWanGroup.getRouteIpsetName(profileId.substring(4)) : VPNClient.getRouteIpsetName(profileId)} dst,dst --map-mark`)
        .comment(this._getPolicyKey());

      if (profileId.startsWith("VWG:"))
        await VirtWanGroup.ensureCreateEnforcementEnv(profileId.substring(4));
      else
        await VPNClient.ensureCreateEnforcementEnv(profileId);
      await this.constructor.ensureCreateEnforcementEnv(this.getUniqueId());

      const vcConfPath = profileId.startsWith("VWG:") ? `${VirtWanGroup.getDNSRouteConfDir(profileId.substring(4), "hard")}/${this.constructor.getDnsmasqConfigFilenamePrefix(this.getUniqueId())}_vc.conf` : `${VPNClient.getDNSRouteConfDir(profileId, "hard")}/${this.constructor.getDnsmasqConfigFilenamePrefix(this.getUniqueId())}_vc.conf`;

      const rule4 = rule.clone().set(this.constructor.getEnforcementIPsetName(this.getUniqueId()), 'src');
      const rule6 = rule.clone().set(this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6), 'src').fam(6);
      const rule4Clear = rule4.clone().jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
      const rule6Clear = rule6.clone().jmp(`MARK --set-xmark 0x0000/${routing.MASK_VC}`);
      if (state === true) {
        iptc.addRule(rule4.opr('-A'));
        iptc.addRule(rule6.opr('-A'));

        // remove rule that was set by state == null
        iptc.addRule(rule4Clear.opr('-D'));
        iptc.addRule(rule6Clear.opr('-D'));
        const markTag = `${profileId.startsWith("VWG:") ? VirtWanGroup.getDnsMarkTag(profileId.substring(4)) : VPNClient.getDnsMarkTag(profileId)}`;
        await fs.promises.writeFile(idConfPath, `group-tag=@${this.constructor.getEnforcementDnsmasqGroupId(this.getUniqueId())}$vc_${this.getUniqueId()}`).catch((err) => {});
        await fs.promises.writeFile(vcConfPath, `tag-tag=$vc_${this.getUniqueId()}$${markTag}$!${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // null means off
      if (state === null) {
        // remove rule that was set by state == true
        iptc.addRule(rule4.opr('-D'));
        iptc.addRule(rule6.opr('-D'));
        // override target and clear vpn client bits in fwmark
        iptc.addRule(rule4Clear.opr('-A'));
        iptc.addRule(rule6Clear.opr('-A'));
        await fs.promises.writeFile(idConfPath, `group-tag=@${this.constructor.getEnforcementDnsmasqGroupId(this.getUniqueId())}$vc_${this.getUniqueId()}`).catch((err) => {});
        await fs.promises.writeFile(vcConfPath, `tag-tag=$vc_${this.getUniqueId()}$${Constants.DNS_DEFAULT_WAN_TAG}`).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
      // false means N/A
      if (state === false) {
        iptc.addRule(rule4.opr('-D'));
        iptc.addRule(rule6.opr('-D'));

        // remove rule that was set by state == null
        iptc.addRule(rule4Clear.opr('-D'));
        iptc.addRule(rule6Clear.opr('-D'));
        await fs.promises.unlink(idConfPath).catch((err) => {});
        await fs.promises.unlink(vcConfPath).catch((err) => {});
        dnsmasq.scheduleRestartDNSService();
      }
    } catch (err) {
      log.error("Failed to set VPN client access on " + this.getUniqueId(), err.message);
    }
  }

  async _dnsmasq(policy) {
    const dnsCaching = policy.dnsCaching;
    const identityIpsetName = this.constructor.getEnforcementIPsetName(this.getUniqueId());
    const identityIpsetName6 = this.constructor.getEnforcementIPsetName(this.getUniqueId(), 6);
    if (dnsCaching === true) {
      Ipset.del(Ipset.CONSTANTS.IPSET_NO_DNS_BOOST, identityIpsetName);
      Ipset.del(Ipset.CONSTANTS.IPSET_NO_DNS_BOOST, identityIpsetName6);
    } else {
      Ipset.add(Ipset.CONSTANTS.IPSET_NO_DNS_BOOST, identityIpsetName);
      Ipset.add(Ipset.CONSTANTS.IPSET_NO_DNS_BOOST, identityIpsetName6);
    }
  }

  getIPs() {
    if (this._ips) {
      return this._ips;
    } else {
      return [];
    }
  }
}

module.exports = Identity;
