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
const HostManager = require('../net2/HostManager.js')
const hostManager = new HostManager();
const sysManager = require('../net2/SysManager.js');
const sem = require('./SensorEventManager.js').getInstance();

const Sensor = require('./Sensor.js').Sensor;

class APCMsgSensor extends Sensor {

  constructor(config) {
    super(config);
    this.ssidProfiles = {};
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
          // wait for 5 seconds in case ssid tag is not synced to TagManaget yet
          setTimeout(() => {
            try {
              this.processSTAUpdateMessage(JSON.parse(message));
            } catch (err) {
              log.error(`Failed to process ssid STA update message: ${message}`, err.message);
            }
          }, 5000);
          break;
        }
        default:
      }
    });

    sclient.subscribe(Message.MSG_FR_CHANGE_APPLIED);
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
  }

  async refreshSSIDSTAMapping() {
    await lock.acquire(LOCK_SSID_UPDATE, async () => {
      const ssidStatus = await fwapc.getAllSSIDStatus().catch((err) => {
        log.error(`Failed to get ssid status from fwapc`, err.message);
        return null;
      });
      if (_.isEmpty(ssidStatus))
        return;

      const macPskMap = {};
      const tags = await TagManager.getPolicyTags("ssidPSK");
      for (const tag of tags) {
        const groupStatus = await fwapc.getGroupStatus(tag.getUniqueId());
        if (_.isArray(groupStatus)) {
          for (const mac of groupStatus)
            macPskMap[mac] = tag.getUniqueId();
        }
      }

      for (const uuid of Object.keys(ssidStatus)) {
        const macs = ssidStatus[uuid];
        if (!_.isArray(macs))
          continue;
        for (const mac of macs)
          await this.updateHostSSID(mac, uuid, macPskMap[mac]);
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
        const groupId = msg.groupId
        if (!uuid)
          return;
        const mac = _.get(msg, ["station", "macAddr"]);
        if (!mac)
          return;
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

    const ssidUserTags = await profile.getTags(Constants.TAG_TYPE_USER);
    const ssidUserTag = ssidUserTags.map(uid => TagManager.getTagByUid(uid)).find(o => _.isObject(o));
    const hostTags = await host.getTags();
    let newTagId = null;
    // overwrite device group with ssid user's affiliated device group
    if (ssidUserTag && ssidUserTag.afTag && !hostTags.includes(ssidUserTag.afTag.getUniqueId()))
      newTagId = ssidUserTag.afTag.getUniqueId()
    // psk group supersedes ssid's device group above
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
}

module.exports = APCMsgSensor;