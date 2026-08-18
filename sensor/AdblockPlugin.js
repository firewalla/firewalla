/*    Copyright 2016-2023 Firewalla Inc.
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

const log = require('../net2/logger.js')(__filename);

const Sensor = require('./Sensor.js').Sensor;

const extensionManager = require('./ExtensionManager.js')

const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');
const IdentityManager = require('../net2/IdentityManager.js');

const rclient = require('../util/redis_manager.js').getRedisClient();
const mclient = require('../util/redis_manager.js').getMetricsRedisClient();

const bone = require("../lib/Bone.js");
const sem = require('../sensor/SensorEventManager.js').getInstance();
const util = require('util');
const _ = require('lodash');
const timeSeries = require('../util/TimeSeries.js').getTimeSeries();
const getHitsAsync = util.promisify(timeSeries.getHits).bind(timeSeries);
const auditTool = require('../net2/AuditTool.js');
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const featureName = "adblock";
const policyKeyName = "adblock";
const adBlockRedisKeyPrefix = "adblock_list:"
const configlistKey = "ads.list"
const RELOAD_INTERVAL = 3600 * 24 * 1000;
const adBlockConfigSuffix = "_adblock_filter.conf";
const policyExtKeyName = "adblock_ext";

const CategoryUpdater = require('../control/CategoryUpdater');
const categoryUpdater = new CategoryUpdater();

const Block = require('../control/Block.js');
const tlsc = require('../control/TLSSetControl.js');
const iptc = require('../control/IptablesControl.js');
const Ipset = require('../net2/Ipset.js');
const { Rule } = require('../net2/Iptables.js');

const Constants = require('../net2/Constants.js');

const ADBLOCK_STRICT_BF_CATEGORY_ID = "adblock_strict";
const ADBLOCK_TLS_RULE_PID = Constants.RESERVED_PID_ADBLOCK_TLS;

const FAMILIES = [4, 6];

// ipset match dimensions: device sets take 1 (src), network sets take 2 (src,src)
const DIM_DEVICE = 1;
const DIM_NETWORK = 2;

const LEVEL_DEV = "DEV";
const LEVEL_DEV_G = "DEV_G";
const LEVEL_NET = "NET";
const LEVEL_NET_G = "NET_G";
const LEVEL_GLOBAL = "GLOBAL";
const LEVELS = [LEVEL_DEV, LEVEL_DEV_G, LEVEL_NET, LEVEL_NET_G, LEVEL_GLOBAL];

const FW_BLOCK_CHAINS = {
  [LEVEL_DEV]: "FW_FIREWALL_DEV_BLOCK",
  [LEVEL_DEV_G]: "FW_FIREWALL_DEV_G_BLOCK",
  [LEVEL_NET]: "FW_FIREWALL_NET_BLOCK",
  [LEVEL_NET_G]: "FW_FIREWALL_NET_G_BLOCK",
  [LEVEL_GLOBAL]: "FW_FIREWALL_GLOBAL_BLOCK",
};

//   app sends true  → settings stores 1  → SCOPE_ON       explicitly enabled, adds a rule on its own entry chain
//   app sends null  → settings stores -1 → SCOPE_EXCLUDED explicitly excluded, adds a RETURN rule on its own tier chain
//   app sends false → settings stores 0  → SCOPE_INHERIT  no stance, inherits the coarser tier, produces no rule
const SCOPE_ON = "on";
const SCOPE_EXCLUDED = "excluded";
const SCOPE_INHERIT = "inherit";



// Entry chain, one per tier
function entryChainOf(level) {
  return `FW_ADBLOCK_ENTRY_${level}`;
}

// Tier chain. Exclusions live here; the last rule is always the jump to the next tier.
function adBlockChainOf(level) {
  return `FW_ADBLOCK_${level}`;
}

// Cascade tail. The tls match and the mark exist only here.
const ADBLOCK_CHAIN_DO = "FW_ADBLOCK_DO";

// Coarse to fine, the ladder reversed: enter at your own tier, only finer tiers can veto you
const CASCADE_CHAINS = LEVELS.slice().reverse().map(adBlockChainOf).concat([ADBLOCK_CHAIN_DO]);

class AdblockScope {
  constructor(label, state, level, set4, set6, dim) {
    this.label = label;
    this.state = state; // state: SCOPE_ON / SCOPE_EXCLUDED / SCOPE_INHERIT
    this.level = level; // dev, dev_g, ...
    this.set4 = set4;
    this.set6 = set6;
    this.dim = dim; // 1/2
  }

  setOf(family) {
    return family === 4 ? this.set4 : this.set6;
  }

  spec() {
    return this.dim === DIM_NETWORK ? 'src,src' : 'src';
  }
}

class AdblockStats {
  constructor() {
    this.lastHitFlow = null;
    this.lastHitTs = 0;
    this.lastFlushTs = 0;
    this.resetTs = 0;
    this.pendingHits = 0;
    this.resetGeneration = 0;
    this.persistPromise = null;
  }

  recordHit(record) {
    if (!record || record.ac !== 'block' || record.reason !== 'adblock')
      return;

    const recordTs = Number(record._ts || record.ts || 0);
    if (recordTs <= this.resetTs)
      return;

    timeSeries.recordHit('feature:adblock:block', record._ts, record.ct);
    this.pendingHits += Math.floor(Number(record.ct) || 1);
    if (!this.lastHitTs || record._ts >= this.lastHitTs) {
      const flow = _.cloneDeep(record);
      if (record.dir === 'L')
        flow.local = true;
      this.lastHitTs = record._ts;
      this.lastHitFlow = flow;
    }
  }

  async flush() {
    if (this.persistPromise)
      await this.persistPromise;

    const now = Date.now() / 1000;
    if (!this.lastHitFlow || now - this.lastFlushTs < 60)
      return;

    this.lastFlushTs = now;
    const payload = {
      kind: 'audit',
      raw: _.cloneDeep(this.lastHitFlow)
    };
    const hitsToFlush = this.pendingHits;
    const flushGeneration = this.resetGeneration;
    this.pendingHits = 0;
    const batch = rclient.batch();
    batch.hset('ext.adblock.stats', 'lastHitTs', String(this.lastHitTs));
    batch.hset('ext.adblock.stats', 'lastHitFlow', JSON.stringify(payload));
    if (hitsToFlush > 0)
      batch.hincrby('ext.adblock.stats', 'totalHits', hitsToFlush);
    const persistPromise = batch.execAsync().catch((err) => {
      log.error('Failed to persist adblock stats', err);
      if (flushGeneration === this.resetGeneration)
        this.pendingHits += hitsToFlush;
    }).finally(() => {
      if (this.persistPromise === persistPromise)
        this.persistPromise = null;
    });
    this.persistPromise = persistPromise;
    await persistPromise;
  }

  async reset() {
    this.resetTs = Math.floor(Date.now() / 1000);
    this.lastHitFlow = null;
    this.lastHitTs = 0;
    this.lastFlushTs = 0;
    this.pendingHits = 0;
    this.resetGeneration++;
    if (this.persistPromise)
      await this.persistPromise;
    await mclient.snapAndFlushMetricsBatch();
    const keys = await mclient.scanResults('timedTraffic:feature:adblock:block:*');
    if (keys.length) {
      await mclient.unlinkAsync(keys);
      mclient.forgetExpireAt(keys);
    }
    const batch = rclient.batch();
    batch.hdel('ext.adblock.stats', 'totalHits', 'lastHitTs', 'lastHitFlow');
    batch.hset('ext.adblock.stats', 'lastResetTs', String(this.resetTs));
    await batch.execAsync().catch(() => {});
  }

  async getStats() {
    const [buckets24h, buckets7d, stored] = await Promise.all([
      getHitsAsync('feature:adblock:block', '1hour', 24).catch(() => []),
      getHitsAsync('feature:adblock:block', '1day', 7).catch(() => []),
      rclient.hgetallAsync('ext.adblock.stats').catch(() => null)
    ]);
    const total24h = (buckets24h || []).reduce((sum, bucket) => sum + (bucket[1] || 0), 0);
    const total7d = (buckets7d || []).reduce((sum, bucket) => sum + (bucket[1] || 0), 0);
    const daily7d = buckets7d || [];
    let totalHits = 0;
    let lastResetTs = null;
    let lastHitTs = null;
    let lastHitFlow = null;
    if (stored) {
      totalHits = Number(stored.totalHits) || 0;
      lastResetTs = stored.lastResetTs ? Number(stored.lastResetTs) : null;
      lastHitTs = stored.lastHitTs ? Number(stored.lastHitTs) : null;
      try {
        const payload = stored.lastHitFlow ? JSON.parse(stored.lastHitFlow) : null;
        lastHitFlow = payload ? await auditTool.formatHitFlow(payload) : null;
      } catch (err) {
        log.warn('Failed to format adblock lastHitFlow', err.message);
      }
    }
    return { total24h, total7d, daily7d, totalHits, lastResetTs, lastHitTs, lastHitFlow };
  }
}

class AdblockPlugin extends Sensor {
    // ===== life cycle and register =====
    constructor(config) {
      super(config);
      this.adblockStats = new AdblockStats();
    }

    async run() {
        this.systemSwitch = false;
        this.adminSystemSwitch = false;

        this.macAddressSettings = {};
        this.networkSettings = {};
        this.tagSettings = {};
        this.identitySettings = {};

        this.nextReloadFilter = [];
        this.reloadCount = 0;
        this.fastMode = true;
        this.tlsGateQueue = null;
        this.tlsScopeStates = {};
        this.tlsGateOpen = null;
        this.tlsTopologyReady = false;

        extensionManager.registerExtension(policyKeyName, this, {
            applyPolicy: this.applyPolicy,
            start: this.globalOn,
            stop: this.globalOff,
        });

        // strict mode hook
        extensionManager.registerExtension(policyExtKeyName, this, {
          applyPolicy: this.applyAdblock
        });
        this.hookFeature(featureName);
        sem.on('ADBLOCK_CONFIG_REFRESH', (event) => {
          this.applyAdblock();
        });
        sem.on('ADBLOCK_RESET', async (event) => {
          try {
            await fc.disableDynamicFeature(featureName)
            for (const tag in this.tagSettings) this.tagSettings[tag] = 0
            for (const uuid in this.networkSettings) this.networkSettings[uuid] = 0
            for (const mac in this.macAddressSettings) this.macAddressSettings[mac] = 0
            for (const guid in this.identitySettings) this.identitySettings[guid] = 0
            await this.applyAdblock();
            const filterKeys = await rclient.scanResults(adBlockRedisKeyPrefix + '*')
            filterKeys.length && await rclient.unlinkAsync(filterKeys)
            this._cleanUpFilter();
            // applyAdblock() above already reset every scope to INHERIT, only the gate is left
            this._scheduleTlsGateSync();
          } catch(err) {
            log.error('Error reseting ADBlock', err)
          }
        });
        sem.on('ADBLOCK_STATS_RESET', () => {
          this.resetAdblockStats().catch(err => log.error('Failed to reset adblock stats', err));
        });
    }

    async job() {
        await this.applyAdblock();
    }

    async apiRun() {
      extensionManager.onCmd("adblockReset", async (msg, data) => {
        try {await extensionManager._precedeRecord(msg.id, {origin: {config: await this.getAdblockConfig(), enabled: fc.isFeatureOn(featureName)}})} catch(err) {};
        sem.sendEventToFireMain({
          type: 'ADBLOCK_RESET'
        });
      });

      extensionManager.onCmd('adblockStatsReset', async (msg, data) => {
        sem.sendEventToFireMain({ type: 'ADBLOCK_STATS_RESET' });
      });
    }

    async globalOn() {
        this.adminSystemSwitch = true;
        this.applyAdblock();
        this._scheduleTlsGateSync();
    }

    async globalOff() {
        this.adminSystemSwitch = false;
        this.applyAdblock();
        this._scheduleTlsGateSync();
    }


    async applyPolicy(host, ip, policy) {
      log.info("Applying adblock policy:", ip, policy);
      try {
        if (ip === '0.0.0.0') {
          if (policy === true) {
            this.systemSwitch = true;
          } else {
            this.systemSwitch = false;
          }
          return this.applySystemAdblock();
        } else {
          if (!host)
            return;
          switch (host.constructor.name) {
            case "Tag": {
              const tagUid = host.o && host.o.uid
              if (tagUid) {
                if (policy === true)
                  this.tagSettings[tagUid] = 1;
                // false means unset, this is for backward compatibility
                if (policy === false)
                  this.tagSettings[tagUid] = 0;
                // null means disabled, this is for backward compatibility
                if (policy === null)
                  this.tagSettings[tagUid] = -1;
                await this.applyTagAdblock(tagUid);
              }
              break;
            }
            case "NetworkProfile": {
              const uuid = host.o && host.o.uuid;
              if (uuid) {
                if (policy === true)
                  this.networkSettings[uuid] = 1;
                if (policy === false)
                  this.networkSettings[uuid] = 0;
                if (policy === null)
                  this.networkSettings[uuid] = -1;
                await this.applyNetworkAdblock(uuid);
              }
              break;
            }
            case "Host": {
              const macAddress = host && host.o && host.o.mac;
              if (macAddress) {
                if (policy === true)
                  this.macAddressSettings[macAddress] = 1;
                if (policy === false)
                  this.macAddressSettings[macAddress] = 0;
                if (policy === null)
                  this.macAddressSettings[macAddress] = -1;
                await this.applyDeviceAdblock(macAddress);
              }
              break;
            }
            default:
              if (IdentityManager.isIdentity(host)) {
                const guid = IdentityManager.getGUID(host);
                if (guid) {
                  if (policy === true)
                    this.identitySettings[guid] = 1;
                  if (policy === false)
                    this.identitySettings[guid] = 0;
                  if (policy === null)
                    this.identitySettings[guid] = -1;
                  await this.applyIdentityAdblock(guid);
                }
              }
          }
        }
      } catch (err) {
        log.error("Got error when applying adblock policy", err);
      }
    }

    async applyAdblock(host, ip, policy) {
      log.info("Apply adblock_ext policy", policy);
      if (typeof policy !== 'undefined') {
        this.userconfig = policy.userconfig
        this.fastMode = policy.fastmode;
        // userconfig above is the only source of strict mode, so sync the gate here.
        // Most of the time the mode did not change and _syncTlsGate() short-circuits
        this._scheduleTlsGateSync();
      }
      this.controlFilter(this.adminSystemSwitch);
      if (typeof policy !== "undefined")
        // if policy is defined, it is invoked from adblock_ext policy, only need to download/remove strict filter via controlFilter
        // no need to apply adblock on devices, otherwise may cause race condition on writing the same config file with different file content during service restart
        return;

      await this.applySystemAdblock();
      for (const macAddress in this.macAddressSettings) {
        await this.applyDeviceAdblock(macAddress);
      }
      for (const tagUid in this.tagSettings) {
        const tagExists = await TagManager.tagUidExists(tagUid);
        if (!tagExists)
          // reset tag if it is already deleted
          this.tagSettings[tagUid] = 0;
        await this.applyTagAdblock(tagUid);
        if (!tagExists)
          delete this.tagSettings[tagUid];
      }
      for (const uuid in this.networkSettings) {
        const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
        if (!networkProfile)
          delete this.networkSettings[uuid];
        else
          await this.applyNetworkAdblock(uuid);
      }
      for (const guid in this.identitySettings) {
        const identity = IdentityManager.getIdentityByGUID(guid);
        if (!identity)
          delete this.identitySettings[guid];
        else
          await this.applyIdentityAdblock(guid);
      }
    }

    async applySystemAdblock() {
      if(this.systemSwitch) {
        return this.systemStart();
      } else {
        return this.systemStop();
      }
    }
  
    async applyTagAdblock(tagUid) {
      if (this.tagSettings[tagUid] == 1)
        return this.perTagStart(tagUid);
      if (this.tagSettings[tagUid] == -1)
        return this.perTagStop(tagUid);
      return this.perTagReset(tagUid);
    }
  
    async applyNetworkAdblock(uuid) {
      if (this.networkSettings[uuid] == 1)
        return this.perNetworkStart(uuid);
      if (this.networkSettings[uuid] == -1)
        return this.perNetworkStop(uuid);
      return this.perNetworkReset(uuid);
    }
  
    async applyDeviceAdblock(macAddress) {
      if (this.macAddressSettings[macAddress] == 1)
        return this.perDeviceStart(macAddress);
      if (this.macAddressSettings[macAddress] == -1)
        return this.perDeviceStop(macAddress);
      return this.perDeviceReset(macAddress);
    }

    async applyIdentityAdblock(guid) {
      if (this.identitySettings[guid] == 1)
        return this.perIdentityStart(guid);
      if (this.identitySettings[guid] == -1)
        return this.perIdentityStop(guid);
      return this.perIdentityReset(guid);
    }


    // ===== per-scope enforcement: dnsmasq conf + TLS rules =====

    async systemStart() {
      log.info("apply adblock globally");
      const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
      const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$${featureName}\nmac-address-tag=%FF:FF:FF:FF:FF:FF$${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({}, SCOPE_ON);
    }
  
    async systemStop() {
      log.info("reset adblock globally");
      const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
      const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$!${featureName}\nmac-address-tag=%FF:FF:FF:FF:FF:FF$!${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({}, SCOPE_INHERIT);
    }
  
    async perTagStart(tagUid) {
      log.info("apply adblock for tag:", tagUid);
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${tagUid}$${featureName}\ngroup-tag=@${tagUid}$${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({ tag: tagUid }, SCOPE_ON);
    }
  
    async perTagStop(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${tagUid}$!${featureName}\ngroup-tag=@${tagUid}$!${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`; // match negative tag
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({ tag: tagUid }, SCOPE_EXCLUDED);
    }
  
    async perTagReset(tagUid) {
      log.info("reset adblock for tag:", tagUid);
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      await fs.unlinkAsync(configFile).catch((err) => {});
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({ tag: tagUid }, SCOPE_INHERIT);
    }
  
    async perNetworkStart(uuid) {
      log.info("apply adblock for network:", uuid);
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
        const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
        if (!iface) {
          log.warn(`Interface name is not found on ${uuid}`);
          return;
        }
        const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
        const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$${featureName}\nmac-address-tag=%00:00:00:00:00:00$${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`;
        await fs.writeFileAsync(configFile, dnsmasqEntry);
        dnsmasq.scheduleRestartDNSService();
        await this._applyTlsRules({ uuid }, SCOPE_ON);
    }
  
    async perNetworkStop(uuid) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
      if (!iface) {
        log.warn(`Interface name is not found on ${uuid}`);
        return;
      }
      const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
      // explicit disable family protect
      const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$!${featureName}\nmac-address-tag=%00:00:00:00:00:00$!${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({ uuid }, SCOPE_EXCLUDED);
    }
  
    async perNetworkReset(uuid) {
      log.info("reset adblock for network:", uuid);
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
      if (!iface) {
        log.warn(`Interface name is not found on ${uuid}`);
        return;
      }
      const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
      // remove config file
      await fs.unlinkAsync(configFile).catch((err) => {});
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({ uuid }, SCOPE_INHERIT);
    }
  
    async perDeviceStart(macAddress) {
      log.info("apply ad block for device:", macAddress);
      const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
      const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$${featureName}\nmac-address-tag=%${macAddress.toUpperCase()}$${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`;
      await fs.writeFileAsync(configFile, dnsmasqentry);
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({ mac: macAddress }, SCOPE_ON);
    }
  
    async perDeviceStop(macAddress) {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
      const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$!${featureName}\nmac-address-tag=%${macAddress.toUpperCase()}$!${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`;
      await fs.writeFileAsync(configFile, dnsmasqentry);
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({ mac: macAddress }, SCOPE_EXCLUDED);
    }
  
    async perDeviceReset(macAddress) {
      log.info("reset adblock for device:", macAddress);
      const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
      // remove config file
      await fs.unlinkAsync(configFile).catch((err) => {});
      dnsmasq.scheduleRestartDNSService();
      await this._applyTlsRules({ mac: macAddress }, SCOPE_INHERIT);
    }

    async perIdentityStart(guid) {
      log.info("reset adblock for identity:", guid);
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (identity) {
        const uid = identity.getUniqueId();
        const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
        const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$${featureName}\ngroup-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`;
        await fs.writeFileAsync(configFile, dnsmasqEntry);
        dnsmasq.scheduleRestartDNSService();
        await this._applyTlsRules({ guid }, SCOPE_ON);
      }
    }
  
    async perIdentityStop(guid) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (identity) {
        const uid = identity.getUniqueId();
        const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
        const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$!${featureName}\ngroup-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$!${ADBLOCK_STRICT_BF_CATEGORY_ID}_block\n`;
        await fs.writeFileAsync(configFile, dnsmasqEntry);
        dnsmasq.scheduleRestartDNSService();
        await this._applyTlsRules({ guid }, SCOPE_EXCLUDED);
      }
    }
  
    async perIdentityReset(guid) {
      log.info("reset adblock for identity:", guid);
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (identity) {
        const uid = identity.getUniqueId();
        const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
        await fs.unlinkAsync(configFile).catch((err) => { });
        dnsmasq.scheduleRestartDNSService();
        await this._applyTlsRules({ guid }, SCOPE_INHERIT);
      }
    }


    // ===== list download and dnsmasq config =====

    async getAdblockConfig() {
      const result = {};
      try {
        if (!platform.isAdblockCustomizedSupported()) {
          result["ads"] = "on"
        } else {
          log.info(`Load config list from bone: ${configlistKey}`);
          const data = await bone.hashsetAsync(configlistKey);
          const adlist = JSON.parse(data);
          // from redis
          const configObj = this.userconfig;
          if (configObj == undefined) {
            for (const key in adlist) {
              const value = adlist[key];
              if (value.default && value.default == true) result[key] = "on";
              else result[key] = "off";
            }
          } else {
            for (const key in configObj) {
              if (Object.keys(adlist).includes(key)) result[key] = configObj[key]
            }
          }
        }
      } catch(err) {
        log.error(`Got error when loading config from adblock`, err);
      }
      return result;
    }

    controlFilter(state) {
      this.nextState = state;
      log.info(`adblock nextState is: ${this.nextState}`);
      if (this.state !== undefined) {
        this.nextReloadFilter.forEach(t => clearTimeout(t));
        this.nextReloadFilter = [];
      }
      if (this.reloadFilterImmediate) {
        clearImmediate(this.reloadFilterImmediate)
      }
      this.reloadFilterImmediate = setImmediate(this._reloadFilter.bind(this));
    }

    _reloadFilter() {
      let preState = this.state;
      let nextState = this.nextState;
      this.state = nextState;
      log.info(`in reloadFilter(adblock): preState: ${preState}, nextState: ${this.state}, this.reloadCount: ${this.reloadCount++}`);
      if (nextState === true) {
        log.info(`Start to update adblock filters.`);
        this.updateFilter()
        .then(()=> {
          log.info(`Update adblock filters successful.`);
          dnsmasq.scheduleRestartDNSService();
          this._scheduleNextReload(nextState, this.nextState);
        })
        .catch(err=>{
          log.error(`Update adblock filters Failed!`, err);
        })
      } else {
        if (preState === false && nextState === false) {
          // disabled, no need do anything
          this._scheduleNextReload(nextState, this.nextState);
          return;
        }
        log.info(`Start to clean up adblock filters.`);
        this._cleanUpFilter();
        void this._cleanupBloomFilter();
        dnsmasq.scheduleRestartDNSService();
        this._scheduleNextReload(nextState, this.nextState);
      }
    }

    _scheduleNextReload(oldNextState, curNextState) {
      if (oldNextState === curNextState) {
        // no need immediate reload when next state not changed during reloading
        this.nextReloadFilter.forEach(t => clearTimeout(t));
        this.nextReloadFilter = [];
        log.info(`schedule next reload for adblock in ${RELOAD_INTERVAL / 1000}s`);
        this.nextReloadFilter.push(setTimeout(this._reloadFilter.bind(this), RELOAD_INTERVAL));
      } else {
        log.warn(`adblock's next state changed from ${oldNextState} to ${curNextState} during reload, will reload again immediately`);
        if (this.reloadFilterImmediate) {
          clearImmediate(this.reloadFilterImmediate)
        }
        this.reloadFilterImmediate = setImmediate(this._reloadFilter.bind(this));
      }
    }

    async updateFilter() {
      const config = await this.getAdblockConfig();
      const strict = config["ads-adv"] === "on";
      if (strict) {
        // enable bloom filter for strict mode only.
        await this._updateBloomFilter();
        this._cleanUpFilter();
      } else {
        await this._updateFilter(config);
        await this._cleanupBloomFilter();
      }
    }

    async _updateFilter(config) {
      this._cleanUpFilter(config);
      for (const key in config) {
        const configFilePath = `${dnsmasqConfigFolder}/${key}${adBlockConfigSuffix}`;
        const value = config[key];
        if (value === 'off') {
          try {
            if (fs.existsSync(configFilePath)) {
              await fs.unlinkAsync(configFilePath);
            }
          } catch (err) {
            log.error(`Failed to remove file: '${configFilePath}'`, err);
          }
          continue;
        }
        let data = null;
        try {
          data = await bone.hashsetAsync(key);
        } catch (err) {
          log.error("Error when load adblocks from bone", err);
          continue;
        }
        let arr = null;
        try {
          arr = JSON.parse(data);
        } catch (err) {
          log.error("Error when parse adblocks", err);
          continue;
        }
        try {
          if (arr.length > 0) {
            await this.writeToFile(adBlockRedisKeyPrefix + key, arr, configFilePath + ".tmp", this.fastMode);
            await fs.accessAsync(configFilePath + ".tmp", fs.constants.F_OK);
            await fs.renameAsync(configFilePath + ".tmp", configFilePath);
          }
        } catch (err) {
          log.error(`Error when write to file: '${configFilePath}'`, err);
        }
      }
    }

    async _updateBloomFilter() {
      log.info("Activate adblock_strict category");
      await categoryUpdater.activateCategory(ADBLOCK_STRICT_BF_CATEGORY_ID);
    }

    async _cleanupBloomFilter() {
      await categoryUpdater.deactivateCategory(ADBLOCK_STRICT_BF_CATEGORY_ID);
    }

    _cleanUpFilter(config) {
      try {
        const result = []
        if (typeof config == 'object') {
          for (const key in config) {
            if(config[key] == "on") result.push(key+adBlockConfigSuffix)
          }
        }
        fs.readdirSync(dnsmasqConfigFolder).forEach(file => {
          if (file.endsWith(adBlockConfigSuffix) && !result.includes(file)) {
            fs.unlinkSync(`${dnsmasqConfigFolder}/${file}`);
          }
        })
      } catch (err) {
        log.err("Failed to delete file,", err)
      }
    }

    async writeToFile(key, hashes, file, fastMode = true) {
      return new Promise( (resolve, reject) =>  {
        log.info("Writing hash filter file:", file);
        let writer = fs.createWriteStream(file);
        writer.on('finish', () => {
          log.info("Finished writing hash filter file", file);
          resolve();
        });
        writer.on('error', err => {
          reject(err);
        });
        if (fastMode) {
          this.preprocess(key, hashes).then(() => {
            let line = util.format("redis-hash-match=/%s/%s%s\n", key, "", "$adblock");
            writer.write(line);
          }).catch((err) => {
            log.error(`Failed to generate adblock config in fast mode`, err.message);
          }).then(() => {
            writer.end();
          });
        } else {
          hashes.forEach((hash) => {
            let line = util.format("hash-address=/%s/%s%s\n", hash.replace(/\//g, '.'), "", "$adblock")
            writer.write(line);
          });
          writer.end();
        }
      });
    }

    async preprocess(key, hashes) {
      await rclient.unlinkAsync(key);
      const cmd = [key];
      const result = cmd.concat(hashes);
      await rclient.saddAsync(result);
    }


    // ===== TLS blocking: scope rules =====
    async _applyTlsRules(target, state) {
      if (this._getSupportedTlsProtos().length === 0)
        return;
      const Host = require('../net2/Host.js');
      const Tag = require('../net2/Tag.js');
      let scopes = [];

      if (target.mac) {
        await Host.ensureCreateEnforcementEnv(target.mac);
        const set = Host.getDeviceSetName(target.mac);
        scopes = [new AdblockScope(`device:${target.mac}`, state, LEVEL_DEV, set, set, DIM_DEVICE)];
      } else if (target.guid) {
        const identityClass = IdentityManager.getIdentityClassByGUID(target.guid);
        if (!identityClass) {
          log.warn("Cannot find identity class of guid", target.guid);
          return;
        }
        const uid = IdentityManager.getNSAndUID(target.guid).uid;
        await identityClass.ensureCreateEnforcementEnv(uid);
        scopes = [new AdblockScope(`identity:${target.guid}`, state, LEVEL_DEV,
          identityClass.getEnforcementIPsetName(uid, 4),
          identityClass.getEnforcementIPsetName(uid, 6), DIM_DEVICE)];
      } else if (target.tag) {
        await Tag.ensureCreateEnforcementEnv(target.tag);
        const devSet = Tag.getTagDeviceSetName(target.tag);
        const netSet = Tag.getTagNetSetName(target.tag);
        scopes = [
          new AdblockScope(`group:${target.tag}:dev`, state, LEVEL_DEV_G, devSet, devSet, DIM_DEVICE),
          new AdblockScope(`group:${target.tag}:net`, state, LEVEL_NET_G, netSet, netSet, DIM_NETWORK)
        ];
      } else if (target.uuid) {
        await NetworkProfile.ensureCreateEnforcementEnv(target.uuid);
        const set = NetworkProfile.getNetListIpsetName(target.uuid);
        scopes = [new AdblockScope(`network:${target.uuid}`, state, LEVEL_NET, set, set, DIM_NETWORK)];
      } else {
        const set = platform.isFireRouterManaged() ? Ipset.CONSTANTS.IPSET_MONITORED_NET : null;
        scopes = [new AdblockScope("all devices", state, LEVEL_GLOBAL, set, set, DIM_NETWORK)];
      }

      for (const scope of scopes)
        await this._applyTlsScope(scope);
    }

    async _applyTlsScope(scope) {
      const key = `${scope.level}|${scope.set4}`;
      if (this.tlsScopeStates[key] === scope.state)
        return;
      await this._ensureTlsTopology();

      const entry = this._tlsEntryRules(scope);
      const exclusion = this._tlsExclusionRules(scope);
      let install = [];
      let remove = [];
      if (scope.state === SCOPE_ON) {
        install = entry;
        remove = exclusion;
      } else if (scope.state === SCOPE_EXCLUDED) {
        install = exclusion;
        remove = entry;
      } else {
        remove = entry.concat(exclusion);
      }
      // Remove before install
      await iptc.addRuleBatch(remove.map(rule => rule.clone().opr('-D')));
      await iptc.addRuleBatch(install);
      this.tlsScopeStates[key] = scope.state;
      log.info(`Adblock TLS scope ${scope.label} = ${scope.state}`);
    }

    // Append: scope rules within an entry chain are mutually exclusive, order does not matter
    _tlsEntryRules(scope) {
      const rules = [];
      for (const family of FAMILIES) {
        const set = scope.setOf(family);
        const rule = new Rule('filter').fam(family).chn(entryChainOf(scope.level));
        // A tier with no ipset covers all traffic at that level, e.g. global on a non-FireRouter box
        if (set)
          rule.set(set, scope.spec());
        rules.push(rule.jmp(adBlockChainOf(scope.level)).opr('-A'));
      }
      return rules;
    }

    // Insert at the head: the jump to the next tier sits at the tail, an appended RETURN is dead
    _tlsExclusionRules(scope) {
      const rules = [];
      for (const family of FAMILIES) {
        const set = scope.setOf(family);
        // Never emit an unconditional RETURN, it would disable the whole tier
        if (!set)
          continue;
        rules.push(new Rule('filter').fam(family).chn(adBlockChainOf(scope.level))
          .set(set, scope.spec()).jmp("RETURN").opr('-I'));
      }
      return rules;
    }


    // ===== TLS blocking: chain topology and gate =====
    async _ensureTlsTopology() {
      if (this.tlsTopologyReady)
        return;
      const chains = LEVELS.map(entryChainOf).concat(CASCADE_CHAINS);
      const rules = [];
      for (const family of FAMILIES) {
        for (const chain of chains)
          rules.push(new Rule('filter').fam(family).chn(chain).opr('-N'));
        // Coarse to fine. This jump is always the chain's last rule, so exclusions must be -I'd above it
        for (let i = 0; i < CASCADE_CHAINS.length - 1; i++) {
          rules.push(new Rule('filter').fam(family)
            .chn(CASCADE_CHAINS[i]).jmp(CASCADE_CHAINS[i + 1]).opr('-A'));
        }
      }
      await iptc.addRuleBatch(rules);
      this.tlsTopologyReady = true;
    }

    // Called when the feature switch or strict mode changes. Scope rules are unaffected.
    // Queued because opening waits on the hostset backfill (up to 30s) and overlapping runs collide
    _scheduleTlsGateSync() {
      this.tlsGateQueue = (this.tlsGateQueue || Promise.resolve())
        .then(() => this._refreshTlsGate())
        .catch((err) => log.error("Failed to sync adblock TLS gate", err.message));
    }

    async _refreshTlsGate() {
      if (this._getSupportedTlsProtos().length === 0)
        return;
      await this._ensureTlsTopology();
      await this._syncTlsGate();
    }

    async _syncTlsGate() {
      const open = Boolean(this.adminSystemSwitch && this._isStrictMode());
      if (this.tlsGateOpen === open)
        return;
      if (open)
        await this._openTlsGate();
      else
        await this._closeTlsGate();
      this.tlsGateOpen = open;
      log.info("Adblock TLS gate is now", open ? "open" : "closed");
    }

    async _openTlsGate() {
      await platform.installTLSModules()
        .catch(err => log.error("Failed to install TLS modules for adblock", err.message));
      await iptc.addRuleBatch(this._tlsMatchRules('-A'));
      this._deactivateTlsHostSet();
      await this._activateTlsHostSet();
      await iptc.addRuleBatch(this._tlsHookRules('-A'));
    }

    async _closeTlsGate() {
      await iptc.addRuleBatch(this._tlsHookRules('-D'));
      await iptc.addRuleBatch(this._tlsMatchRules('-D'));
      this._deactivateTlsHostSet();
    }

    _tlsHookRules(op) {
      const rules = [];
      for (const level of LEVELS) {
        for (const family of FAMILIES) {
          rules.push(new Rule('filter').fam(family)
            .chn(FW_BLOCK_CHAINS[level]).jmp(entryChainOf(level)).opr(op));
        }
      }
      return rules;
    }

    _tlsMatchRules(op) {
      const tlsHostSet = Block.getTLSHostSet(ADBLOCK_STRICT_BF_CATEGORY_ID);
      const mark = `MARK --set-xmark ${Rule.stdMark(ADBLOCK_TLS_RULE_PID)}`;
      const rules = [];
      for (const proto of this._getSupportedTlsProtos()) {
        const tlsModule = proto === "tcp" ? "tls" : "udp_tls";
        for (const family of FAMILIES) {
          rules.push(new Rule('filter').fam(family).chn(ADBLOCK_CHAIN_DO)
            .pro(proto).mdl(tlsModule, `--tls-hostset ${tlsHostSet}`).jmp(mark).opr(op));
        }
      }
      return rules;
    }


    // ===== TLS blocking: mode and hostset =====
    _isStrictMode() {
      if (!platform.isAdblockCustomizedSupported())
        return false;
      return _.get(this, ["userconfig", "ads-adv"]) === "on";
    }

    _getSupportedTlsProtos() {
      const protos = [];
      if (platform.isTLSBlockSupport()) {
        protos.push("tcp");
      }
      if (platform.isUdpTLSBlockSupport()) {
        protos.push("udp");
      }
      return protos;
    }

    async _activateTlsHostSet() {
      for (const proto of this._getSupportedTlsProtos()) {
        try {
          await categoryUpdater.activateTLSCategory(ADBLOCK_STRICT_BF_CATEGORY_ID, proto);
        } catch (err) {
          log.error("Failed to activate adblock TLS category", proto, err.message);
        }
      }
    }

    _deactivateTlsHostSet() {
      const tlsHostSet = Block.getTLSHostSet(ADBLOCK_STRICT_BF_CATEGORY_ID);
      for (const proto of this._getSupportedTlsProtos())
        tlsc.deactivateTLSSet(tlsHostSet, proto);
    }


    // ===== stats (delegated to AdblockStats) =====

    recordAdblockHit(record) {
      return this.adblockStats.recordHit(record);
    }

    async flushAdblockStats() {
      return this.adblockStats.flush();
    }

    async resetAdblockStats() {
      return this.adblockStats.reset();
    }

    async getAdblockStats() {
      return this.adblockStats.getStats();
    }
}

module.exports = AdblockPlugin
