/*    Copyright 2020-2023 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename, 'info');
const { Sensor } = require('./Sensor.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const MessageBus = require('../net2/MessageBus.js');
const Message = require('../net2/Message.js');
const fc = require('../net2/config.js');

const HostManager = require('../net2/HostManager.js');
const hostManager = new HostManager();
const sysManager = require('../net2/SysManager.js')
const networkProfileManager = require('../net2/NetworkProfileManager.js')
const NetworkProfile = require('../net2/NetworkProfile.js');
const Host = require('../net2/Host.js');
const Alarm = require('../alarm/Alarm.js');
const AM2 = require('../alarm/AlarmManager2.js');
const am2 = new AM2();
const PM2 = require('../alarm/PolicyManager2.js');
const pm2 = new PM2();
const { getPreferredBName } = require('../util/util.js')
const _ = require('lodash');
const Constants = require('../net2/Constants.js');
const TagManager = require('../net2/TagManager.js');
const delay = require('../util/util.js').delay;
const HostTool = require('../net2/HostTool.js');
const hostTool = new HostTool();
const era = require('../event/EventRequestApi.js');
const Ipset = require('../net2/Ipset.js');
const extensionManager = require('./ExtensionManager.js');
const blockControl = require('../control/BlockControl.js');
const AsyncLock = require('../vendor_lib/async-lock');

const FEATURE_KEY = 'new_device_tag' // new_device_tag indicates whether new device quarantine is enabled
const ALARM_FEATURE_KEY = 'new_device' // new_device indicates whether new device alarm is enabled

const NETWORK_SET = Ipset.CONSTANTS.IPSET_NEW_DEV_NETWORK;
const EXEMPT_MAC_SET = Ipset.CONSTANTS.IPSET_NEW_DEV_EXEMPT_MAC;
const EXEMPT_SET = Ipset.CONSTANTS.IPSET_NEW_DEV_EXEMPT;
const LOCK_CONFIG = 'config';
const DELETED_TTL = 3600 * 1000;

function copyPolicy(policy) {
  try {
    if (!policy) return {}
    return JSON.parse(JSON.stringify(policy))
  } catch(err) {
    log.error('Failed to parse policy', policy, err)
    return {}
  }
}

// a decided device is exempt by MAC as source, and by its per-host IP sets as destination. The entries
// of those sets time out after 900 s without a sighting, which leaves two cases on the destination side:
// - an address another device takes over stays exempt until the entry times out. Accepted: it only
//   lets connections in, the new device's own traffic stays blocked
// - Known issue: connections towards a decided device not sighted for 900 s are blocked until its
//   next sighting. Group rules match the same way
function exemptOps(op, mac) {
  return [
    `${op} ${EXEMPT_MAC_SET} ${mac}`,
    `${op} ${EXEMPT_SET} ${Host.getIpSetName(mac, 4)}`,
    `${op} ${EXEMPT_SET} ${Host.getIpSetName(mac, 6)}`,
  ];
}

// The kernel blocks a device on a quarantine-on network until this sensor has decided about it: the
// quarantine group's iptables rules are rendered once more for devices that are neither in the group
// nor in the exempt sets (Block.setupTagsRules). The group's DNS (dnsmasq) rules apply only once the
// device is in the group. This sensor owns the exempt sets: every device that went through the
// decision, whatever the outcome.
//
// Known issue: the decision starts only when the box discovers the device, so the block lasts until
// then: at once for a device that asks for a lease, up to the next scan (minutes) for one with a
// fixed address or one deleted while it stays connected.
class NewDeviceTagSensor extends Sensor {

  constructor(config) {
    super(config)

    // use dedicated instance as messageBus can't deal with multiple subscribers well
    this.messageBus = new MessageBus('info', 'newDeviceTag')
    this.queue = []
    this.enqueueEvent = this.enqueueEvent.bind(this)
    this.lock = new AsyncLock();
    this.pending = new Map(); // mac -> the decision not finished yet, compared by identity
    this.decided = new Set(); // MACs whose decision has finished, whatever its outcome; the exempt sets hold the same devices
    this.queuedOps = []; // lines for the exempt sets that no write has taken yet
    this.queuedMacs = new Set(); // the devices those lines name
    this.writing = null; // the running write of the exempt sets
    this.recentlyDeleted = new Map(); // mac -> time of Device:Delete
    this.applied = null; // last applied { tagUids, networks }; this.config is the sensor config
    this.started = false;
  }

  async checkAndExecutePolicy(mac, host, decision) {
    try {
      const hostObj = await hostManager.getHostAsync(mac)
      if (!hostObj) {
        log.error('Host not found in HostManager', host)
        return
      }

      if (sysManager.isMyMac(mac)) {
        log.info('Skipping firewalla mac', host)
        return
      }

      log.info('Checking new device', host)

      // a new Host creates its ipsets in the background, and tags() links them into the group
      // without creating them: a link to a missing set fails with only a log line
      await Host.ensureCreateEnforcementEnv(mac)

      await hostManager.loadPolicyAsync()
      const systemPolicy = copyPolicy(hostManager.policy.newDeviceTag)
      systemPolicy.key = 'policy:system'
      log.debug(systemPolicy)

      const intf = sysManager.getInterfaceViaUUID(hostObj.o.intf)
      let networkPolicy = {}
      if (!intf) {
        log.warn('Device without interface', mac)
      } else {
        if (hostObj.o.ipv4Addr && hostObj.o.ipv4Addr == intf.gateway ||
          hostObj.ipv6Addr && hostObj.ipv6Addr.includes(intf.gateway6)
        ) {
          log.info('Skipping gateway mac', host)
          return
        }

        const networkProfile = networkProfileManager.getNetworkProfile(intf.uuid)
        networkPolicy = copyPolicy(networkProfile.policy.newDeviceTag)
        networkPolicy.key = networkProfile._getPolicyKey()
      }

      let policy = networkPolicy.state && networkPolicy || systemPolicy.state && systemPolicy || null
      // new device quarantine is on as long as either level is on, attribute it to system level first
      const policyLvl = systemPolicy.state ? 'system' : 'intf'

      log.debug(networkPolicy)

      const isFWAP = this.isFirewallaAP(hostObj);
      let isQuarantine = 0

      if (!isFWAP && policy) {
        const ssidPSKTags = await TagManager.getPolicyTags("ssidPSK");
        if (policy) {
          if (!_.isEmpty(ssidPSKTags))
            // there is ssid/PSK group mapping configured, hold for a while and see if the device is already assigned to another group.
            // SSID STA status is updated once every 2 seconds in fwapc in the first 10 minutes after a wireless STA is connected. So, 10 seconds should be enough.
            await delay(10000);
          const tags = await hostObj.getTags();
          if (!_.isEmpty(tags)) {
            log.warn(`Device ${mac} is already added to another group, new device tag will not be enforced`, tags);
            policy = null;
            // a group assigned before the decision ran may still be waiting for its policy apply
            if (this.hasQuarantineGroup(tags))
              await hostObj.tags(tags);
          } else {
            const tagCandidate = await hostTool.getWirelessDeviceTagCandidate(mac);
            if (!_.isEmpty(tagCandidate)) {
              if (tagCandidate !== "null") {
                log.warn(`Device ${mac} should be added to group ${tagCandidate}, new device tag will not be enforced`);
                policy = null;
                await hostObj.setPolicyAsync('tags', [tagCandidate]);
                if (this.hasQuarantineGroup([tagCandidate]))
                  await hostObj.tags([tagCandidate]);
              }
              // delete cached tag uid candidate from redis immediately after it is used, in case the device is deleted and discovered as a new device again, new candidate will be regenerated
              await hostTool.deleteWirelessDeviceTagCandidate(mac);
            }
          }
          // check again and see if the new device needs to be put into quarantine group
          if (policy) {
            // tags() puts the device into the group's sets now and persists the policy; the policy
            // apply would do the same 3 s later, after markDecided has exempted the device
            await hostObj.tags([policy.tag])
            log.info(`Added new device ${host.ipv4Addr} - ${host.mac} to group ${policy.tag} per ${policy.key}`)
            const tagExists = await TagManager.tagUidExists(policy.tag);
            if (tagExists) {
              isQuarantine = 1
              // fire an action event on new_device_quarantine with device info
              const tag = TagManager.getTagByUid(policy.tag);
              await era.addActionEvent("new_device_quarantine", 1, {
                "mac": host.mac,
                "deviceName": getPreferredBName(host) || "Unknown",
                "ip": host.ipv4Addr || host.ipv6Addr && host.ipv6Addr[0] || "",
                "intf": host.intf || "",
                "tag": String(policy.tag),
                "tagName": tag && tag.getTagName() || "",
                "policyLvl": policyLvl
              });
            }
          }
        }
      }
      if (fc.isFeatureOn(ALARM_FEATURE_KEY)) {
        const name = getPreferredBName(host) || "Unknown"
        const alarm = new Alarm.NewDeviceAlarm(new Date() / 1000,
          name,
          {
            "p.device.id": name,
            "p.device.name": name,
            "p.device.ip": host.ipv4Addr || host.ipv6Addr && host.ipv6Addr[0] || "",
            "p.device.mac": host.mac,
            "p.device.vendor": host.macVendor,
            "p.intf.id": host.intf ? host.intf : "",
            "p.quarantine": isQuarantine
          });
        if (!isFWAP && policy && [policy.tag].map(String))
          alarm["p.tag.ids"] = [policy.tag].map(String);
        am2.enqueueAlarm(alarm);
      }
    } catch(err) {
      log.error("Error adding new device", err)
    } finally {
      // whatever the outcome, the device is decided about. an error here leaves it as it is today,
      // not quarantined, rather than blocked until the next FireMain start
      await this.markDecided(mac, decision).catch((err) => {
        log.error(`Failed to mark ${mac} as decided`, err.message);
      });
    }
  }

  enqueueEvent(event) {
    this.queue.push(event)
  }

  isFirewallaAP(hostObj) {
    const mac = _.get(hostObj, ["o", "mac"], "").toUpperCase();

    if (mac.startsWith(Constants.FW_AP_MAC_PREFIX) || mac.startsWith(Constants.FW_AP_CEILING_MAC_PREFIX))
      return true;

    return false;
  }

  newDecision(mac) {
    const decision = { running: false };
    this.pending.set(mac, decision);
    return decision;
  }

  hasQuarantineGroup(tags) {
    const tagUids = hostManager.getNewDeviceTagConfig().tagUids;
    return tags.some(uid => tagUids.has(String(uid)));
  }

  // one writer at a time on the non-deferred path, so when the call returns the kernel has the changes
  // in the order this.decided was updated. Callers that arrive during a write share the next restore,
  // so a burst of Device:Delete becomes a few restores
  writeExempt(macs, ops) {
    for (const mac of macs)
      this.queuedMacs.add(mac);
    Array.prototype.push.apply(this.queuedOps, ops);
    if (!this.writing)
      this.writing = this.drainExempt();
    return this.writing;
  }

  // the per-host sets are created before the restore that names them: an add or del naming a set
  // that does not exist fails the whole restore
  async drainExempt() {
    try {
      while (this.queuedOps.length) {
        const macs = this.queuedMacs, ops = this.queuedOps;
        this.queuedMacs = new Set();
        this.queuedOps = [];
        for (const mac of macs)
          await Host.ensureCreateEnforcementEnv(mac);
        await Ipset.restore(ops);
      }
    } finally {
      // in the same step as the last look at the queue, so no caller can join a writer that is done
      this.writing = null;
    }
  }

  // the exempt set holds the same per-host IP sets the quarantine group matches on the destination
  // side, so a quarantined device is a member before it is exempt as long as the decision awaits
  // tags() first, which it does
  async markDecided(mac, decision) {
    if (decision !== undefined) {
      if (this.pending.get(mac) !== decision)
        return; // deleted or rediscovered while the decision ran, that outcome does not count
      this.pending.delete(mac);
    }
    this.decided.add(mac);
    await this.writeExempt([mac], exemptOps('add', mac));
  }

  onHostUpdated(channel, mac, id, o) {
    mac = mac && mac.toUpperCase();
    if (!mac)
      return;
    // a record for a MAC this sensor does not know: a deleted device whose host:mac another writer
    // recreated, so DeviceHook sends no NewDeviceFound and no Device:Create for it. It is handled as
    // a create with no pending decision, or it would stay blocked for good. With the feature off
    // that only consumes the delete marker
    if (!this.pending.has(mac) && !this.decided.has(mac)) {
      this.onDeviceCreate(channel, "Host:Updated", mac, o).catch((err) => {
        log.error(`Failed to decide about ${mac}`, err.message);
      });
    }
  }

  // every known host is decided, except the ones whose decision is still running. in the init phase
  // the restore becomes an atomic swap, so stale members of the previous run drop out
  async reconcile() {
    // the redis records, not getHostsAsync: in FireMain that builds a Host for every record, which
    // creates its ipsets and applies its policy, for devices that may not have been seen in a year
    const entries = await hostTool.getAllMACEntries();
    // this.decided is kept, not rebuilt: a decision that completed while the records were being read
    // is in it and not in the snapshot, and a delete removes from it as it happens
    for (const entry of entries) {
      const mac = entry.mac;
      // a record of a recently deleted MAC is stale or still being deleted; if the device came back
      // and was decided about since, this.decided already has it
      if (!hostTool.isMacAddress(mac) || this.deletedRecently(mac) || this.pending.has(mac))
        continue;
      this.decided.add(mac);
    }
    const ops = [`create ${EXEMPT_MAC_SET} hash:mac`, `create ${EXEMPT_SET} list:set`];
    for (const mac of this.decided)
      Array.prototype.push.apply(ops, exemptOps('add', mac));
    await this.writeExempt(this.decided, ops);
    log.info(`Reconciled ${this.decided.size} decided devices`);
  }

  async onDeviceCreate(channel, type, mac, host) {
    mac = mac && mac.toUpperCase();
    if (!mac)
      return;
    if (this.pending.has(mac))
      return this.decide(mac, host, this.pending.get(mac));
    // a create after a delete is the device coming back (or a discovery create that outlived the
    // delete); either way its record is current again, so the reconcile may trust it from now on
    const deleted = this.deletedRecently(mac);
    this.recentlyDeleted.delete(mac);
    if (!fc.isFeatureOn(FEATURE_KEY) || this.decided.has(mac))
      return; // a repeated create of a device already decided about changes nothing
    // no NewDeviceFound for this MAC: the device coming back takes a fresh decision, anything else
    // is a host restored through the host:create API, never evaluated for quarantine
    if (deleted)
      return this.decide(mac, host, this.newDecision(mac));
    await this.markDecided(mac);
  }

  // the markers are only pruned on the next delete, so the age is checked here
  deletedRecently(mac) {
    const ts = this.recentlyDeleted.get(mac);
    return ts !== undefined && Date.now() - ts < DELETED_TTL;
  }

  // DeviceHook can publish Device:Create more than once for one discovery; the pending decision runs once
  async decide(mac, host, decision) {
    if (decision.running)
      return;
    decision.running = true;
    await this.checkAndExecutePolicy(mac, host, decision);
  }

  async onDeviceDelete(channel, type, mac) {
    mac = mac && mac.toUpperCase();
    if (!mac)
      return;
    this.pending.delete(mac);
    const now = Date.now();
    this.recentlyDeleted.set(mac, now);
    for (const [m, ts] of this.recentlyDeleted) {
      if (now - ts > DELETED_TTL)
        this.recentlyDeleted.delete(m);
    }
    // the kernel entries are deleted whether or not this.decided knows the device: after a start with
    // the feature off it is empty while the previous run's entries are still in the sets
    this.decided.delete(mac);
    await this.writeExempt([mac], exemptOps('del', mac));
    blockControl.scheduleRefreshConnmark();
  }

  // the extension hook for the newDeviceTag policy of the system and of each network
  async applyPolicy(host, ip, policy) {
    await this.applyConfig();
  }

  // the quarantine-on networks go into the network set, and when the quarantine groups change their
  // rules are rendered again, with or without the undecided-device copies
  // the system and the network policy hooks run under different locks and can overlap, so the
  // read, diff and write of one transition are serialized here
  applyConfig() {
    return this.lock.acquire(LOCK_CONFIG, () => this.applyConfigLocked());
  }

  async applyConfigLocked() {
    if (!this.started)
      return;
    const config = hostManager.getNewDeviceTagConfig();
    const previous = this.applied || { tagUids: new Set(), networks: {} };
    const sameUids = _.isEqual([...config.tagUids].sort(), [...previous.tagUids].sort());
    const sameNetworks = _.isEqual(Object.keys(config.networks).sort(), Object.keys(previous.networks).sort());
    if (sameUids && sameNetworks)
      return;
    this.applied = config;
    log.info(`Quarantine groups ${[...config.tagUids]}, networks ${Object.keys(config.networks)}`);
    for (const uuid of Object.keys(previous.networks)) {
      if (!(uuid in config.networks))
        await this.setNetwork(uuid, false);
    }
    let added = false;
    for (const uuid of Object.keys(config.networks)) {
      if (!(uuid in previous.networks)) {
        await this.setNetwork(uuid, true);
        added = true;
      }
    }
    // connections an undecided device on a newly covered network already has ride the fast path
    if (added)
      blockControl.scheduleRefreshConnmark();
    if (sameUids)
      return;
    const changed = [...config.tagUids, ...previous.tagUids].filter(uid => config.tagUids.has(uid) !== previous.tagUids.has(uid));
    await this.renderRules(changed);
  }

  // renders the rules of these groups again, with or without the undecided-device copies
  async renderRules(uids) {
    // before the policy queue exists the start enforcement has not run yet, and it renders every rule
    // from the current config
    if (!pm2.queue)
      return;
    const changed = new Set(uids.map(String));
    const prefix = Constants.TAG_TYPE_MAP[Constants.TAG_TYPE_GROUP].ruleTagPrefix;
    const rules = await pm2.loadActivePoliciesAsync();
    // Known issue: a re-enforce removes the whole rule and adds it again, one rule after the other,
    // so each rule is off for a few seconds for the group's members and for undecided devices, as
    // after a rule edit. Adding or removing only the copies, in one batch, would close that
    for (const rule of rules) {
      if (!_.isArray(rule.tag) || !rule.tag.some(t => changed.has(String(t).replace(prefix, ""))))
        continue;
      await pm2.enforceOnQueue({ action: 'reenforce', policy: rule, oldPolicy: rule }).catch((err) => {
        log.error(`Failed to re-enforce policy ${rule.pid}`, err.message);
      });
    }
  }

  async setNetwork(uuid, on) {
    const op = on ? Ipset.add : Ipset.del;
    // at a cold boot the profile's sets may not be created yet, and an add naming a missing set fails
    if (on)
      await NetworkProfile.ensureCreateEnforcementEnv(uuid);
    await op(NETWORK_SET, NetworkProfile.getNetIpsetName(uuid));
    await op(NETWORK_SET, NetworkProfile.getNetIpsetName(uuid, 6));
    await op(NETWORK_SET, NetworkProfile.getNetLinklocalIpsetName(uuid));
  }

  async globalOn() {
    await this.reconcile();
    this.started = true;
    this.applied = null;
    await this.applyConfig();
  }

  async globalOff() {
    // the config helper is empty while the feature is off, so this removes the networks and the copies
    await this.applyConfig();
    this.started = false;
  }

  run() {
    // ensure new devices found before IPTABLES_READY will be checked as well
    sem.on('NewDeviceFound', this.enqueueEvent)

    extensionManager.registerExtension('newDeviceTag', this, { applyPolicy: this.applyPolicy });

    sem.once('IPTABLES_READY', () => {
      sem.removeListener('NewDeviceFound', this.enqueueEvent)
      sem.on('NewDeviceFound', (event) => {
        if (!fc.isFeatureOn(FEATURE_KEY)) return
        this.newDecision(event.host.mac.toUpperCase())
      })
      for (const event of this.queue) {
        if (fc.isFeatureOn(FEATURE_KEY))
          this.newDecision(event.host.mac.toUpperCase())
      }
      this.queue = []

      // Device:Create is the time that host info is written to redis; a pending decision for the MAC
      // says whether a NewDeviceFound preceded it
      this.messageBus.subscribe("DiscoveryEvent", "Device:Create", null, this.onDeviceCreate.bind(this))
      this.messageBus.subscribe("DiscoveryEvent", "Device:Delete", null, this.onDeviceDelete.bind(this))
      this.messageBus.subscribe(Host.getUpdateCh(), "", this.onHostUpdated.bind(this))
      // a network created while the system switch is on has no newDeviceTag policy of its own, so the
      // extension hook never fires for it; this event follows its enforcement sets being created
      sem.on(Message.MSG_OSI_NETWORK_PROFILE_INITIALIZED, () => {
        this.applyConfig().catch((err) => {
          log.error("Failed to apply quarantine config", err.message);
        });
      })

      this.hookFeature(FEATURE_KEY)
    })
  }

}

module.exports = NewDeviceTagSensor;
