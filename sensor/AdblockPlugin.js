/*    Copyright 2016 - 2022 Firewalla Inc.
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
const bone = require("../lib/Bone.js");
const sem = require('../sensor/SensorEventManager.js').getInstance();
const util = require('util');
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();

const fc = require('../net2/config.js');

const featureName = "adblock";
const policyKeyName = "adblock";
const adBlockRedisKeyPrefix = "adblock_list:"
const configlistKey = "ads.list"
const RELOAD_INTERVAL = 3600 * 24 * 1000;
const adBlockConfigSuffix = "_adblock_filter.conf";
const policyExtKeyName = "adblock_ext";

class AdblockPlugin extends Sensor {
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
        extensionManager.registerExtension(policyKeyName, this, {
            applyPolicy: this.applyPolicy,
            start: this.start,
            stop: this.stop
        });
        extensionManager.registerExtension(policyExtKeyName, this, {
          applyPolicy: this.applyAdblock
        });
        this.hookFeature(featureName);
        sem.on('ADBLOCK_CONFIG_REFRESH', (event) => {
          this.applyAdblock();
        });
    }

    async job() {
        await this.applyAdblock();
    }

    async apiRun() {
    }

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

    async applyPolicy(host, ip, policy) {
      log.info("Applying adblock policy:", ip, policy);
      try {
        if (ip === '0.0.0.0') {
          if (policy === true) {
            this.systemSwitch = true;
            if (fc.isFeatureOn(featureName, true)) {//compatibility: new firewlla, old app
              await fc.enableDynamicFeature(featureName);
              return;
            }
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
    _scheduleNextReload(oldNextState, curNextState) {
      if (oldNextState === curNextState) {
        // no need immediate reload when next state not changed during reloading
        this.nextReloadFilter.forEach(t => clearTimeout(t));
        this.nextReloadFilter.length = 0;
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
      await this._updateFilter(config);
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
        dnsmasq.scheduleRestartDNSService();
        this._scheduleNextReload(nextState, this.nextState);
      }
    }
    controlFilter(state) {
      this.nextState = state;
      log.info(`adblock nextState is: ${this.nextState}`);
      if (this.state !== undefined) {
        this.nextReloadFilter.forEach(t => clearTimeout(t));
        this.nextReloadFilter.length = 0;
      }
      if (this.reloadFilterImmediate) {
        clearImmediate(this.reloadFilterImmediate)
      }
      this.reloadFilterImmediate = setImmediate(this._reloadFilter.bind(this));
    }

    async applyAdblock(host, ip, policy) {
      if (typeof policy !== 'undefined') {
        this.userconfig = policy.userconfig
        this.fastMode = policy.fastmode;
      }
      this.controlFilter(this.adminSystemSwitch);

      await this.applySystemAdblock();
      for (const macAddress in this.macAddressSettings) {
        await this.applyDeviceAdblock(macAddress);
      }
      for (const tagUid in this.tagSettings) {
        const tag = TagManager.getTagByUid(tagUid);
        if (!tag)
          // reset tag if it is already deleted
          this.tagSettings[tagUid] = 0;
        await this.applyTagAdblock(tagUid);
        if (!tag)
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

    async systemStart() {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
      const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async systemStop() {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
      const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async perTagStart(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${tagUid}$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async perTagStop(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${tagUid}$!${featureName}\n`; // match negative tag
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async perTagReset(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      await fs.unlinkAsync(configFile).catch((err) => {});
      await dnsmasq.scheduleRestartDNSService();
    }
  
    async perNetworkStart(uuid) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
        const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
        if (!iface) {
          log.warn(`Interface name is not found on ${uuid}`);
          return;
        }
        const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${featureName}_${iface}.conf`;
        const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$${featureName}\n`;
        await fs.writeFileAsync(configFile, dnsmasqEntry);
        dnsmasq.scheduleRestartDNSService();
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
      const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  
    async perNetworkReset(uuid) {
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
    }
  
    async perDeviceStart(macAddress) {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
      const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqentry);
      dnsmasq.scheduleRestartDNSService();
    }
  
    async perDeviceStop(macAddress) {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
      const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqentry);
      dnsmasq.scheduleRestartDNSService();
    }
  
    async perDeviceReset(macAddress) {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_${macAddress}.conf`;
      // remove config file
      await fs.unlinkAsync(configFile).catch((err) => {});
      dnsmasq.scheduleRestartDNSService();
    }

    async perIdentityStart(guid) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (identity) {
        const uid = identity.getUniqueId();
        const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
        const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$${featureName}\n`;
        await fs.writeFileAsync(configFile, dnsmasqEntry);
        dnsmasq.scheduleRestartDNSService();
      }
    }
  
    async perIdentityStop(guid) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (identity) {
        const uid = identity.getUniqueId();
        const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
        const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$!${featureName}\n`;
        await fs.writeFileAsync(configFile, dnsmasqEntry);
        dnsmasq.scheduleRestartDNSService();
      }
    }
  
    async perIdentityReset(guid) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (identity) {
        const uid = identity.getUniqueId();
        const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${featureName}.conf`;
        await fs.unlinkAsync(configFile).catch((err) => { });
        dnsmasq.scheduleRestartDNSService();
      }
    }

    // global on/off
    async globalOn() {
        this.adminSystemSwitch = true;
        this.applyAdblock();
    }

    async globalOff() {
        this.adminSystemSwitch = false;
        this.applyAdblock();
    }
}

module.exports = AdblockPlugin
