/*    Copyright 2020-2026 Firewalla Inc.
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

const f = require('./Firewalla.js');
const sysManager = require('./SysManager.js');
const exec = require('child-process-promise').exec
const Ipset = require('./Ipset.js');
const iptc = require('../control/IptablesControl.js');
const VPNClient = require('../extension/vpnclient/VPNClient.js');
const VirtWanGroup = require('./VirtWanGroup.js');
const { Rule } = require('./Iptables.js');
const fs = require('fs');
const Promise = require('bluebird');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const freeradius = require('../extension/freeradius/freeradius.js');
const dnsmasq = new DNSMASQ();
const Monitorable = require('./Monitorable');
const Constants = require('./Constants.js');
const _ = require('lodash');
Promise.promisifyAll(fs);
const scheduler = require('../util/scheduler.js');
const HostTool = require('./HostTool.js');
const hostTool = new HostTool();
const fwapc = require('./fwapc.js');
const {delay} = require('../util/util.js');
const { hashsetAsync } = require('../lib/Bone.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();

const envCreatedMap = {};


class Tag extends Monitorable {
  static metaFieldsNumber = ["createTs"];

  constructor(o) {
    if (!Monitorable.instances[o.uid]) {
      super(o)
      Monitorable.instances[o.uid] = this

      if (f.isMain()) (async () => {
        await sysManager.waitTillIptablesReady()
        await this.createEnv();
        await this.applyPolicy();
      })().catch(err => {
        log.error(`Error initializing Host ${this.o.mac}`, err);
      })

      log.info(`Created new ${this.getTagType()} Tag: ${this.getUniqueId()}`)
      if (f.isMain()) {
        this.fwapcSetGroupMACsJob = new scheduler.UpdateJob(this.fwapcSetGroupMACs.bind(this), 5000);
      }
    }
    return Monitorable.instances[o.uid]
  }

  getUniqueId() {
    return this.o.uid
  }

  setTagName(name) {
    this.o.name = name;
  }

  getTagName() {
    return this.o.name;
  }

  getTagType() {
    return this.o.type || Constants.TAG_TYPE_GROUP;
  }

  getReadableName() {
    return this.o.name || super.getReadableName()
  }

  getTagUid() {
    return this.o.uid;
  }

  getMetaKey() {
    return Constants.TAG_TYPE_MAP[this.getTagType()].redisKeyPrefix + this.getUniqueId()
  }

  _getPolicyKey() {
    return `policy:tag:${this.o.uid}`;
  }

  // this can be used to match everything on this tag, including device and network
  static getTagSetName(uid) {
    return `c_tag_${uid}_set`;
  }

  // this can be used to match device alone on this tag
  static getTagDeviceMacSetName(uid) {
    return `c_tag_${uid}_dev_mac_set`
  }

  // this can be used to add to list:set of another tag, i.e. a tag can belong to another tag
  static getTagDeviceIPSetName(uid, af = 4) {
    return `c_tag_${uid}_dev_ip${af}_set`
  }

  // this can be used to match network alone on this tag
  static getTagNetSetName(uid) {
    return `c_tag_${uid}_net_set`;
  }

  // this can be used to match mac as well as IP of device on this tag
  static getTagDeviceSetName(uid) {
    return `c_tag_${uid}_dev_set`;
  }

  static async ensureCreateEnforcementEnv(uid) {
    if (envCreatedMap[uid])
      return;
    log.verbose(`Creating env for Tag: ${uid}`)
    // create related ipsets
    Ipset.create(Tag.getTagSetName(uid), 'list:set');
    Ipset.create(Tag.getTagDeviceMacSetName(uid), 'hash:mac', false, { hashsize: 1024 });
    Ipset.create(Tag.getTagDeviceIPSetName(uid, 4), 'hash:net', false, { hashsize: 1024, timeout: 900 });
    Ipset.create(Tag.getTagDeviceIPSetName(uid, 6), 'hash:net', true, { hashsize: 1024, timeout: 900 });
    Ipset.add(Tag.getTagSetName(uid), Tag.getTagDeviceMacSetName(uid));
    // you may think this tag net set is redundant? 
    // it is needed to apply fine-grained policy on tag level. e.g., customized wan, QoS
    Ipset.create(Tag.getTagNetSetName(uid), 'list:set');
    // it can be used to match src,dst on devices in the group
    Ipset.create(Tag.getTagDeviceSetName(uid), 'list:set');
    Ipset.add(Tag.getTagDeviceSetName(uid), Tag.getTagDeviceMacSetName(uid));
    envCreatedMap[uid] = 1;
  }

  async resetPolicies() {
    await this.loadPolicyAsync();
    for (const key of Object.keys(this.policy)) {
      if (key === "freeradius_server") {
        await freeradius.reconfigServer(this.o.uid, {});
      }
    }
  }

  async createEnv() {
    await Tag.ensureCreateEnforcementEnv(this.o.uid);
  }

  async destroyEnv() {
    const PM2 = require('../alarm/PolicyManager2.js');
    const pm2 = new PM2();
    await pm2.deleteTagRelatedPolicies(this.o.uid);
    const EM = require('../alarm/ExceptionManager.js');
    const em = new EM();
    await em.deleteTagRelatedExceptions(this.o.uid);

    const FlowAggrTool = require('../net2/FlowAggrTool');
    const flowAggrTool = new FlowAggrTool();

    await flowAggrTool.removeAggrFlowsAllTag(this.o.uid);

    // flush related ipsets
    Ipset.flush(Tag.getTagSetName(this.o.uid));
    Ipset.flush(Tag.getTagDeviceMacSetName(this.o.uid));
    Ipset.flush(Tag.getTagDeviceIPSetName(this.o.uid, 4));
    Ipset.flush(Tag.getTagDeviceIPSetName(this.o.uid, 6));
    Ipset.flush(Tag.getTagNetSetName(this.o.uid));
    Ipset.flush(Tag.getTagDeviceSetName(this.o.uid));
    // delete related dnsmasq config files
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}_*`).catch((err) => {}); // delete files in global effective directory
    await exec(`sudo rm -f ${f.getUserConfigFolder()}/dnsmasq/*/tag_${this.o.uid}_*`).catch((err) => {}); // delete files in network-wise effective directories
    dnsmasq.scheduleRestartDNSService();
    await this.fwapcDeleteGroup().catch((err) => {});
  }

  async ipAllocation(policy) {
    await dnsmasq.writeAllocationOption(this.getUniqueId(), policy, true)
  }

  async qos(state) {
    // do nothing for qos on tag
  }

  async acl(state) {
    // do nothing for acl on tag
  }

  async spoof(state) {
    // do nothing for spoof on tag
  }

  async shield(policy) {
  }

  async getVpnClientProfileId() {
    if (!this.policy)
      await this.loadPolicyAsync();
    if (this.policy.vpnClient) {
      if (this.policy.vpnClient.state === true && this.policy.vpnClient.profileId)
        return this.policy.vpnClient.profileId;
    }
    return null;
  }

  getVPNClientRules(profileId, af = 4) {
    if (!profileId) return [];
    const uid = this.getUniqueId();
    const routeIpset = Monitorable.getVPNClientRouteIpsetName(profileId);
    return [
      new Rule("mangle").chn("FW_RT_TAG_DEVICE_5")
        .mdl("set", `--match-set ${Tag.getTagDeviceSetName(uid)} src`)
        .jmp(`SET --map-set ${routeIpset} dst,dst --map-mark`)
        .comment(`policy:tag:${uid}`),
      new Rule("mangle").chn("FW_RT_TAG_NETWORK_5")
        .mdl("set", `--match-set ${Tag.getTagNetSetName(uid)} src,src`)
        .jmp(`SET --map-set ${routeIpset} dst,dst --map-mark`)
        .comment(`policy:tag:${uid}`)
    ];
  }

  getVPNClientTagEntry() {
    const uid = this.getUniqueId();
    return `group-tag=@${uid}$vc_tag_${uid}`;
  }

  getVPNClientTag() {
    return `vc_tag_${this.getUniqueId()}`;
  }

  async tags(tags, type = Constants.TAG_TYPE_GROUP) {
    // a tag can belong to another tag, in real practice, a group can belong to a user
    const policyKey = _.get(Constants.TAG_TYPE_MAP, [type, "policyKey"]);
    if (!policyKey) {
      log.error(`Unknown tag type ${type}, ignore tags`, tags);
      return;
    }
    const TagManager = require('./TagManager.js');
    tags = (tags || []).map(String);
    this[`_${policyKey}`] = this[`_${policyKey}`] || [];
    // remove old tags that are not in updated tags
    const removedTags = this[`_${policyKey}`].filter(uid => !tags.includes(uid));
    for (let removedTag of removedTags) {
      const tagExists = await TagManager.tagUidExists(removedTag, type);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(removedTag);
        for (const setName of [Tag.getTagDeviceSetName(removedTag), Tag.getTagSetName(removedTag)]) {
          Ipset.del(setName, Tag.getTagDeviceMacSetName(this.o.uid));
          Ipset.del(setName, Tag.getTagDeviceIPSetName(this.o.uid, 4));
          Ipset.del(setName, Tag.getTagDeviceIPSetName(this.o.uid, 6));
        }
      }
    }
    await fs.unlinkAsync(`${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}.conf`).catch((err) => {});
    // filter updated tags in case some tag is already deleted from system
    const updatedTags = [];
    for (let uid of tags) {
      const tagExists = await TagManager.tagUidExists(uid, type);
      if (tagExists) {
        await Tag.ensureCreateEnforcementEnv(uid);
        for (const setName of [Tag.getTagDeviceSetName(uid), Tag.getTagSetName(uid)]) {
          Ipset.add(setName, Tag.getTagDeviceMacSetName(this.o.uid));
          Ipset.add(setName, Tag.getTagDeviceIPSetName(this.o.uid, 4));
          Ipset.add(setName, Tag.getTagDeviceIPSetName(this.o.uid, 6));
        }
        updatedTags.push(uid);
      }
    }
    if (!_.isEmpty(updatedTags))
      await dnsmasq.writeConfig(`${f.getUserConfigFolder()}/dnsmasq/tag_${this.o.uid}.conf`, `group-group=@${this.o.uid}${updatedTags.map(t => `@${t}`)}`);
    dnsmasq.scheduleRestartDNSService();
    this[`_${policyKey}`] = updatedTags;
    await this.setPolicyAsync(policyKey, this[`_${policyKey}`]); // keep tags in policy data up-to-date
  }

  static async scheduleFwapcSetGroupMACs(uid, type) {
    const TagManager = require('./TagManager.js');
    // in case tag is stored in redis but not synced into firemain, wait for it to become available in TagManager
    let retryCount = 5;
    while (await TagManager.tagUidExists(uid, type) && retryCount-- > 0) {
      const tag = await TagManager.getTagByUid(uid);
      if (tag) {
        tag.fwapcSetGroupMACsJob.exec().catch((err) => {});
        break;
      }
      await delay(3000);
    }
  }

  async fwapcSetGroupMACs() {
    if (!platform.isFireRouterManaged())
      return;
    // if tag type is device, skip sync to fwapc
    if (this.getTagType() === Constants.TAG_TYPE_DEVICE)
      return;
    const HostManager = require('./HostManager.js');
    const hostManager = new HostManager();
    const macs = await hostManager.getTagMacs(this.o.uid).then(results => results.filter(m => hostTool.isMacAddress(m))).catch((err) => {
      log.error(`Failed to get MAC addresses in group ${this.o.uid}`, err.message);
      return null;
    });
    if (macs) {
      await fwapc.setGroup(this.o.uid, { macs }).catch((err) => {
        log.error(`Failed to set group ACL in fwapc for ${this.getTagType()} ${this.o.uid}`, err.message);
      });
    }
  }

  async fwapcDeleteGroup() {
    if (!platform.isFireRouterManaged())
      return;
    await fwapc.deleteGroup(this.o.uid).catch((err) => {
      log.error(`Failed to delete group ACL in fwapc for ${this.getTagType()} ${this.o.uid}`, err.message);
    });
  }
}

module.exports = Tag;
