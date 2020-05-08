/*    Copyright 2016 - 2020 Firewalla Inc
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

const fc = require('../net2/config.js');

const featureName = "adblock";
const policyKeyName = "adblock";

class AdblockPlugin extends Sensor {
    async run() {
        this.systemSwitch = false;
        this.adminSystemSwitch = false;
        this.macAddressSettings = {};
        this.networkSettings = {};
        this.tagSettings = {};
        extensionManager.registerExtension(policyKeyName, this, {
            applyPolicy: this.applyPolicy,
            start: this.start,
            stop: this.stop
        });

        this.hookFeature(featureName);
    }

    async job() {
        await this.applyAdblock();
    }

    async apiRun() {
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
          }
        }
      } catch (err) {
        log.error("Got error when applying adblock policy", err);
      }
    }

    async applyAdblock() {
      dnsmasq.controlFilter('adblock', this.adminSystemSwitch);

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
