/*    Copyright 2020-2024 Firewalla Inc.
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

const log = require("../net2/logger.js")(__filename);

const Constants = require("../net2/Constants.js");
const fwapc = require('../net2/fwapc.js');
const sclient = require('../util/redis_manager.js').getSubscriptionClient();
const Message = require('../net2/Message.js');
const TagManager = require('../net2/TagManager.js');
const _ = require('lodash');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_SSID_UPDATE = "LOCK_SSID_UPDATE";
const LOCK_RULE_UPDATE = "LOCK_RULE_UPDATE";
const HostManager = require('../net2/HostManager.js')
const hostManager = new HostManager();
const sysManager = require('../net2/SysManager.js');
const HostTool = require("../net2/HostTool.js");
const hostTool = new HostTool();
const uuid = require('uuid');
const bro = require('../net2/BroDetect.js');
const sem = require('./SensorEventManager.js').getInstance();
const PolicyManager2 = require('../alarm/PolicyManager2.js');
const Policy = require("../alarm/Policy.js");
const pm2 = new PolicyManager2();
const SUPPORTED_RULE_TYPES = ["device", "tag", "network", "intranet"];
const scheduler = require('../extension/scheduler/scheduler.js');


const Sensor = require('./Sensor.js').Sensor;
const sl = require('./SensorLoader.js');

class APCMsgSensor extends Sensor {

  constructor(config) {
    super(config);
    this.ssidProfiles = {};
    this.ssidGroupMap = {};
    this.enforcedRules = {};
    this.policyInitialized = false;
    sl.initSingleSensor("ACLAuditLogPlugin").then((r) => {this.aclAuditLogPlugin = r}).catch((err) => {
      log.error("Failed to init ACLAuditLogPlugin", this.aclAuditLogPlugin);
    });
  }

  async run() {
    await this.loadCachedSSIDProfiles();
    await this.reloadSSIDProfiles();

    sclient.on("message", async (channel, message) => {
      switch (channel) {
        case Message.MSG_FR_CHANGE_APPLIED: {
          await this.reloadSSIDProfiles();
          break;
        }
        case Message.MSG_FWAPC_SSID_STA_UPDATE: {
          // wait for 5 seconds in case ssid tag is not synced to TagManager yet
          setTimeout(() => {
            let msg = null;
            try {
              msg = JSON.parse(message);
            } catch (err) {
              log.error(`Malformed JSON in ${Message.MSG_FWAPC_SSID_STA_UPDATE} message: ${message}`, err.message);
            }
            if (msg)
              this.processSTAUpdateMessage(msg).catch((err) => {
                log.error(`Failed to process ${Message.MSG_FWAPC_SSID_STA_UPDATE} message: ${message}`, err.message);
              });
          }, 5000);
          break;
        }
        case Message.MSG_FWAPC_CONNTRACK_UPDATE: {
          let msg = null;
          try {
            msg = JSON.parse(message);
          } catch (err) {
            log.error(`Malformed JSON in ${Message.MSG_FWAPC_CONNTRACK_UPDATE} message: ${message}`, err.message);
          }
          if (msg)
            this.processConntrackUpdateMessage(msg).catch((err) => {
              log.error(`Failed to process ${Message.MSG_FWAPC_CONNTRACK_UPDATE} message: ${message}`, err.message);
            })
          break;
        }
        case Message.MSG_FWAPC_BLOCK_FLOW: {
          try {
            this.processApcBlockFlowMessage(message);
          } catch(err) {
            log.error(`Failed to process ${Message.MSG_FWAPC_BLOCK_FLOW} message: ${message}`, err.message);
          };
          break;
        }
        default:
      }
    });

    sclient.subscribe(Message.MSG_FR_CHANGE_APPLIED);
    sclient.subscribe(Message.MSG_FWAPC_CONNTRACK_UPDATE);
    sclient.subscribe(Message.MSG_FWAPC_BLOCK_FLOW);
    // wait for iptables ready in case Host object and its ipsets are created in HostManager.getHostAsync
    await sysManager.waitTillIptablesReady();
    sclient.subscribe(Message.MSG_FWAPC_SSID_STA_UPDATE);
    await this.refreshSSIDSTAMapping().catch((err) => {
      log.error(`Failed to refresh ssid sta mapping`, err.message);
    });

    // sync ssid sta mapping once every minute to ensure consistency in case sta update message is missing somehow
    setInterval(async () => {
      this.refreshSSIDSTAMapping().catch((err) => {
        log.error(`Failed to refresh ssid sta mapping`, err.message);
      });
    }, 60000);

    // scheduled rule activated
    sem.on("Policy:Activated", async (event) => {
      await lock.acquire(LOCK_RULE_UPDATE, async () => {
        if (!this.policyInitialized)
          return;
        const policy = event.policy;
        if (!policy || !policy.pid)
          return;
        const pid = String(policy.pid);
        if (!this.isAPCSupportedRule(policy)) {
          if (_.has(this.enforcedRules, pid))
            await fwapc.deleteRule(pid);
          delete this.enforcedRules[pid];
        } else {
          await fwapc.updateRule(policy);
          this.enforcedRules[pid] = 1;
        }
      });
    });
    // scheduled rule deactivated
    sem.on("Policy:Deactivated", async (event) => {
      await lock.acquire(LOCK_RULE_UPDATE, async () => {
        if (!this.policyInitialized)
          return;
        const policy = event.policy;
        if (!policy || !policy.pid)
          return;
        const pid = String(policy.pid);
        if (_.has(this.enforcedRules, pid))
          await fwapc.deleteRule(pid);
        delete this.enforcedRules[pid];
      });
    });

    sem.on("Policy:AllInitialized", async () => {
      await lock.acquire(LOCK_RULE_UPDATE, async () => {
        const rules = (await pm2.loadActivePoliciesAsync() || []).filter(rule => this.isAPCSupportedRule(rule) && (!rule.cronTime || scheduler.shouldPolicyBeRunning(rule)));
        for (const rule of rules) {
          if (rule.pid)
            this.enforcedRules[String(rule.pid)] = 1;
        }
        this.policyInitialized = true;
        await fwapc.updateRules(rules, true);
      }).catch((err) => {
        log.error(`Failed to sync all rules to fwapc`, err.message);
      });
    });
  }

  isAPCSupportedRule(rule) {
    const {type, guids, scope, tag, target} = rule;
    if (!SUPPORTED_RULE_TYPES.includes(type))
      return false;
    if (!_.isEmpty(guids))
      return false;
    if (_.isArray(scope) && scope.some(h => !hostTool.isMacAddress(h)))
      return false;
    if (_.isArray(tag) && tag.some(t => !t.startsWith(Policy.TAG_PREFIX) && !t.startsWith(Policy.INTF_PREFIX)))
      return false;
    if (type === "device" && !hostTool.isMacAddress(target))
      return false;
    return true;
  }

  async refreshSSIDSTAMapping() {
    await lock.acquire(LOCK_SSID_UPDATE, async () => {
      const ssidStatus = await fwapc.getAllSSIDStatus().catch((err) => {
        log.error(`Failed to get ssid status from fwapc`, err.message);
        return null;
      });
      if (_.isEmpty(ssidStatus))
        return;

      const tags = await TagManager.getPolicyTags("ssidPSK");
      const ssidVlanGroupMap = {};
      const ssidGroupMap = {};
      for (const tag of tags) {
        const ssidPSK = await tag.getPolicyAsync("ssidPSK");
        if (_.isObject(ssidPSK)) {
          if (_.has(ssidPSK, "vlan")) {
            if (_.isObject(ssidPSK.psks)) {
              for (const uuid of Object.keys(ssidPSK.psks))
                ssidVlanGroupMap[`${uuid}::${ssidPSK.vlan}`] = tag;
            }
          }
          if (_.isArray(ssidPSK.defaultSSIDs)) {
            for (const uuid of ssidPSK.defaultSSIDs)
              ssidGroupMap[uuid] = tag;
          }
        }
      }
      this.ssidGroupMap = ssidGroupMap;
      const usedSSIDProfiles = {};
      const config = await fwapc.getConfig();
      const assets = _.get(config, "assets");
      const templates = _.get(config, "assets_template");
      for (const uid of Object.keys(assets)) {
        const templateId = _.get(assets, [uid, "templateId"]);
        const template = _.get(templates, templateId);
        if (template) {
          const networks = _.get(template, "wifiNetworks");
          if (_.isArray(networks)) {
            for (const network of networks) {
              const ssidProfiles = _.get(network, "ssidProfiles") || [];
              const aliasSSIDs = _.get(network, "aliasSSIDs") || [];
              for (const uuid of ssidProfiles.concat(aliasSSIDs)) {
                usedSSIDProfiles[uuid] = 1;
              }
            }
          }
        }
      }

      for (const uuid of Object.keys(ssidStatus)) {
        if (!_.has(usedSSIDProfiles, uuid))
          continue;
        const status = ssidStatus[uuid];
        if (!_.isObject(status))
          continue;
        for (const key of Object.keys(status)) {
          if (!_.isArray(status[key]))
            continue;
          if (key === "phy") { // STA MACs that do not belong to a PSK group
            for (const mac of status[key])
              await this.updateHostSSID(mac.toUpperCase(), uuid, ssidGroupMap[uuid] && ssidGroupMap[uuid].getUniqueId());
          } else {
            if (key.startsWith("vlan:")) { // STA MACs that belong to a PSK group
              const vid = key.substring("vlan:".length);
              const ssidVlanId = `${uuid}::${vid}`;
              for (const mac of status[key])
                await this.updateHostSSID(mac.toUpperCase(), uuid, ssidVlanGroupMap[ssidVlanId] && ssidVlanGroupMap[ssidVlanId].getUniqueId());
            }
          }
        }
      }
    }).catch((err) => {
      log.error(`Failed to refresh ssid sta mapping`, err.message);
    });
  }

  // update device and ssid mapping by setting ssidTags in device policy
  async processSTAUpdateMessage(msg) {
    /*
      {
        "action": "join",
        "id": "539dd9d7-acaf-477c-a0ad-ed5784dd18b6", // ssid profile uuid
        "groupId": 5, // psk group id
        "station": {
          "assetUID": "20:6D:31:AA:BC:10",
          "assocTime": 3,
          "band": "5g",
          "bssid": "20:6D:31:AA:BC:13",
          "channel": 44,
          "intf": "ath1",
          "macAddr": "4E:2F:3B:44:AD:AA",
          "phymode": "IEEE80211_MODE_11BEA_EHT80",
          "rssi": -48,
          "rxRate": 1080,
          "rxnss": 2,
          "snr": 48,
          "ssid": "MelvinWifi",
          "ts": 1723433071,
          "txRate": 309,
          "txnss": 2
        }
      }
    */
    await lock.acquire(LOCK_SSID_UPDATE, async () => {
      if (msg.action === "join") {
        const uuid = msg.id;
        let groupId = msg.groupId
        if (!uuid)
          return;
        const mac = _.get(msg, ["station", "macAddr"]);
        if (!mac)
          return;
        const dvlanId = _.get(msg, ["station", "dvlanVlanId"]);
        if (!groupId && !dvlanId) // if dynamic vlan id is set and group id is not set, the station belongs to a microsegment that does not map to a group, do not add to group of the ssid's default segment
          groupId = this.ssidGroupMap[uuid] && this.ssidGroupMap[uuid].getUniqueId();
        await this.updateHostSSID(mac, uuid, groupId);
      }
    }).catch((err) => {
      log.error(`Failed to process STA update message: ${msg}`, err.message);
    });
  }

  async updateHostSSID(mac, uuid, groupId) {
    const profile = this.ssidProfiles[uuid];
    if (!profile) {
      log.warn(`Cannot find ssid profile with uuid ${uuid}`);
      return;
    }
    
    const host = await hostManager.getHostAsync(mac.toUpperCase());
    if (!host) {
      log.warn(`Unknown mac address ${mac}`);
      return;
    }
    await host.setPolicyAsync(_.get(Constants.TAG_TYPE_MAP, [Constants.TAG_TYPE_SSID, "policyKey"]), [profile.getUniqueId()]);

    let newTagId = null;
    if (groupId && await TagManager.tagUidExists(groupId, Constants.TAG_TYPE_GROUP))
      newTagId = groupId;
    if (!_.isEmpty(newTagId))
      await host.setPolicyAsync(_.get(Constants.TAG_TYPE_MAP, [Constants.TAG_TYPE_GROUP, "policyKey"]), [newTagId]);
  }

  async loadCachedSSIDProfiles() {
    await lock.acquire(LOCK_SSID_UPDATE, async () => {
      const tags = await TagManager.refreshTags();
      for (const uid of Object.keys(tags)) {
        if (tags[uid].getTagType() === Constants.TAG_TYPE_SSID) {
          const uuid = tags[uid].getTagName();
          this.ssidProfiles[uuid] = tags[uid];
        }
      }
    }).catch((err) => {
      log.error(`Failed to load cached ssid profiles`, err.message);
    });
  }

  // create, update or remove ssid tag object
  async reloadSSIDProfiles() {
    await lock.acquire(LOCK_SSID_UPDATE, async () => {
      // sync ssid tags from TagManager and remove non-existing ones according to latest ssid profiles in apc config
      if (!this._profilesInitialized) {
        const ssidTags = _.pickBy(await TagManager.refreshTags(), t => t.getTagType() == Constants.TAG_TYPE_SSID);
        for (const uid of Object.keys(ssidTags)) {
          if (ssidTags[uid].uuid)
            this.ssidProfiles[ssidTags[uid].uuid] = ssidTags[uid];
        }
        this._profilesInitialized = true;
      }
      const config = await fwapc.getConfig();
      const ssidProfiles = _.get(config, "profile");
      const removedProfiles = _.pick(this.ssidProfiles, Object.keys(this.ssidProfiles).filter(ssid => !_.has(ssidProfiles, ssid)));
      for (const uuid of Object.keys(removedProfiles)) {
        const profile = removedProfiles[uuid];
        if (profile)
          await TagManager.removeTag(profile.getUniqueId());
        delete(this.ssidProfiles[uuid]);
      }
      for (const uuid of Object.keys(ssidProfiles)) {
        const obj = Object.assign({}, ssidProfiles[uuid], {uuid, type: Constants.TAG_TYPE_SSID});
        // create or update ssid tag, use uuid as name attribute here because tag uses name attribute to dedup
        this.ssidProfiles[uuid] = await TagManager.createTag(uuid, obj);
      }
    }).catch((err) => {
      log.error(`Failed to reload ssid profiles`, err.message);
    });
  }

  async processConntrackUpdateMessage(msg) {
    /*
      [
        {
          "ts": 1726199969,
          "af": 4,
          "sh": "192.168.77.73",
          "dh": "192.168.77.158",
          "sp": [41312,41316],
          "dp": 5201,
          "ob": 351585454,
          "rb": 1224460,
          "pr": "tcp"
        }
      ] 
    */
    if (!_.isArray(msg) || _.isEmpty(msg))
      return;
    for (const log of msg) {
      const {ts, af, sh, dh, sp, dp, ob, rb, pr, cnt} = log;
      if (sh === dh)
        continue;
      if (af === 4 && (sysManager.isMyIP(sh) || sysManager.isMyIP(dh)))
        continue;
      if (af === 6 && (sysManager.isMyIP6(sh) || sysManager.isMyIP6(dh)))
        continue;
      // FIXME: duration is to be added in conntrack events from fwapc
      const du = log.du || 1;
      const smac = await hostTool.getMacByIPWithCache(sh);
      const dmac = await hostTool.getMacByIPWithCache(dh);
      const origPackets = Math.max(Math.floor(ob / 1000), 1);
      const respPackets = Math.max(Math.floor(rb / 1000), 1);

      const connLog = {
        "id.orig_h": sh,
        "id.resp_h": dh,
        "id.orig_p": sp,
        "id.resp_p": dp,
        "proto": pr,
        "orig_bytes": ob,
        "resp_bytes": rb,
        "orig_pkts": origPackets,
        "resp_pkts": respPackets,
        "orig_ip_bytes": ob + origPackets * 20,
        "resp_ip_bytes": rb + respPackets * 20,
        "missed_bytes": 0,
        "local_orig": true,
        "local_resp": true,
        "orig_l2_addr": smac,
        "resp_l2_addr": dmac,
        "conn_state": "SF",
        "duration": du,
        "ts": ts - du,
        "uid": uuid.v4().substring(0, 8),
        "bridge": true
      }
      bro.processConnData(JSON.stringify(connLog)).catch((err) => {
        log.error(`Failed to process local conn log in zeek`, connLog, err.message);
      });
    }
  }

  processApcBlockFlowMessage(msg) {
    try { msg = JSON.parse(msg)} catch (err) {
      log.error(`Malformed JSON in ${Message.MSG_FWAPC_BLOCK_FLOW} message: ${msg}`);
      return
    }
    const record = {
      type: 'ip', ts: msg.ts, ct: msg.ct,
      sh: msg.src, dh: msg.dst,
      sp: [msg.sport], dp: msg.dport,
      mac: msg.smac, dmac: msg.dmac,
      fd: 'lo', dir: 'L',
      isoLVL: msg.iso_lvl,
      orig: 'ap',
    };
    record.ac = msg.action
    if (msg.pid) record.pid = msg.pid
    if (msg.proto) record.pr = msg.proto
    if (msg.iso_lvl && msg.action == "block") record.ac = "isolation"
    if (msg.gid) record.isoGID = msg.gid
    if (msg.hasOwnProperty('iso_ext')) record.isoExt = msg.iso_ext
    if (msg.hasOwnProperty('iso_int')) record.isoInt = msg.iso_int

    const intf = sysManager.getInterfaceViaIP(msg.src || msg.dst);
    record.intf = intf && intf.name;
    if (msg.iso_lvl == 2 && intf) record.isoNID = intf.uuid; // network isolate

    if (this.aclAuditLogPlugin) // in case AclAuditLogPlugin not loaded
      this.aclAuditLogPlugin.writeBuffer(msg.smac, record);
  }
}

module.exports = APCMsgSensor;