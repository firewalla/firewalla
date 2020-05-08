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
const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const FALLBACK_FAMILY_DNS = ["8.8.8.8"]; // these are just backup servers
let FAMILY_DNS = null;
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const fc = require('../net2/config.js');


const featureName = "family_protect";
const policyKeyName = "family";

class FamilyProtectPlugin extends Sensor {
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
        await this.applyFamilyProtect();
    }

    async apiRun() {

    }

    async applyPolicy(host, ip, policy) {
        log.info("Applying family protect policy:", ip, policy);
        try {
            if (ip === '0.0.0.0') {
                if (policy == true) {
                    this.systemSwitch = true;
                    if (fc.isFeatureOn(featureName, true)) {//compatibility: new firewlla, old app
                        await fc.enableDynamicFeature(featureName);
                    }
                } else {
                    this.systemSwitch = false;
                }
                return this.applySystemFamilyProtect();
            } else {
                if (!host)
                  return;
                switch (host.constructor.name) {
                  case "Tag": {
                    const tagUid = host.o && host.o.uid;
                    if (tagUid) {
                      if (policy === true)
                        this.tagSettings[tagUid] = 1;
                      // false means unset, this is for backward compatibility
                      if (policy === false)
                        this.tagSettings[tagUid] = 0;
                      // null means disabled, this is for backward compatibility
                      if (policy === null)
                        this.tagSettings[tagUid] = -1;
                      await this.applyTagFamilyProtect(tagUid);
                    }
                    break;
                  }
                  case "NetworkProfile": {
                    const uuid = host.o && host.o.uuid
                    if (uuid) {
                      if (policy === true)
                        this.networkSettings[uuid] = 1;
                      if (policy === false)
                        this.networkSettings[uuid] = 0;
                      if (policy === null)
                        this.networkSettings[uuid] = -1;
                      await this.applyNetworkFamilyProtect(uuid);
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
                      await this.applyDeviceFamilyProtect(macAddress);
                    }
                    break;
                  }
                  default: 
                }
                
            }
        } catch (err) {
            log.error("Got error when applying family protect policy", err);
        }
    }

    async applyFamilyProtect() {
      const configFilePath = `${dnsmasqConfigFolder}/${featureName}.conf`;
      if (this.adminSystemSwitch) {
        const dnsaddrs = await this.familyDnsAddr();
        const dnsmasqEntry = `server=${dnsaddrs[0]}$${featureName}`;
        await fs.writeFileAsync(configFilePath, dnsmasqEntry);
      } else {
        await fs.unlinkAsync(configFilePath).catch((err) => {});
      }
      
      await this.applySystemFamilyProtect();
      for (const macAddress in this.macAddressSettings) {
        await this.applyDeviceFamilyProtect(macAddress);
      }
      for (const tagUid in this.tagSettings) {
        const tag = TagManager.getTagByUid(tagUid);
        if (!tag)
          // reset tag if it is already deleted
          this.tagSettings[tagUid] = 0;
        await this.applyTagFamilyProtect(tagUid);
        if (!tag)
          delete this.tagSettings[tagUid];
      }
      for (const uuid in this.networkSettings) {
        const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
        if (!networkProfile)
          delete this.networkSettings[uuid];
        else
          await this.applyNetworkFamilyProtect(uuid);
      }
    }

    async applySystemFamilyProtect() {
      if (this.systemSwitch) {
        return this.systemStart();
      } else {
        return this.systemStop();
      }
    }

    async applyTagFamilyProtect(tagUid) {
      if (this.tagSettings[tagUid] == 1)
        return this.perTagStart(tagUid);
      if (this.tagSettings[tagUid] == -1)
        return this.perTagStop(tagUid);
      return this.perTagReset(tagUid);
    }

    async applyNetworkFamilyProtect(uuid) {
      if (this.networkSettings[uuid] == 1)
        return this.perNetworkStart(uuid);
      if (this.networkSettings[uuid] == -1)
        return this.perNetworkStop(uuid);
      return this.perNetworkReset(uuid);
    }

    async applyDeviceFamilyProtect(macAddress) {
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
        dnsmasq.scheduleRestartDNSService();
    }

    async systemStop() {
      const configFile = `${dnsmasqConfigFolder}/${featureName}_system.conf`;
      const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$!${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }

    async perTagStart(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${tagUid}$${featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }

    async perTagStop(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${tagUid}$!${featureName}\n`; // match negative tag
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }

    async perTagReset(tagUid) {
      const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${featureName}.conf`;
      await fs.unlinkAsync(configFile).catch((err) => {});
      dnsmasq.scheduleRestartDNSService();
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
        await this.applyFamilyProtect();
    }

    async globalOff() {
        this.adminSystemSwitch = false;
        await this.applyFamilyProtect();
    }

  async familyDnsAddr() {
    if (FAMILY_DNS && FAMILY_DNS.length != 0) {
      return FAMILY_DNS;
    }
    return new Promise((resolve, reject) => {
      f.getBoneInfo((err, data) => {
        if (data && data.config && data.config.dns && data.config.dns.familymode) {
          FAMILY_DNS = data.config.dns.familymode
          resolve(FAMILY_DNS);
        } else {
          resolve(FALLBACK_FAMILY_DNS);
        }
      });
    });
  }
}

module.exports = FamilyProtectPlugin
