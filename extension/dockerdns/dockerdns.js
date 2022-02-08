/*    Copyright 2022 Firewalla Inc.
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

const extensionManager = require('./ExtensionManager.js')
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');
const IdentityManager = require('../net2/IdentityManager.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;
const VPNClient = require('../extension/vpnclient/VPNClient.js');

// FIXME:
// assume related vpn profile has already been created before using this docker dns code logic
// this is an experiment on using docker as DNS upstream dns
class DockerDNS {
  constructor(config = {}) {
    this.config = config;
    this.profileId = config.profileId;
    this.featureName = config.featureName;
    this.type = config.type;
    this.refreshEvent = `${this.featureName.toUpperCase()}_REFRESH`;
  }

  async run() {
    this.systemSwitch = false;
    this.featureSwitch = false;
    this.networkSettings = {};
    this.tagSettings = {};
    this.macAddressSettings = {};
    this.identitySettings = {};

    extensionManager.registerExtension(this.featureName, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });

    await exec(`mkdir -p ${dnsmasqConfigFolder}`);

    this.hookFeature(this.featureName);
  }

  async apiRun() {
  }

  // GLOBAL
  async applyGlobalOn() {
    this.systemSwitch = true;
    const configFile = `${dnsmasqConfigFolder}/${this.featureName}_system.conf`;
    const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$${this.featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async applyGlobalOff() {
    this.systemSwitch = true;
    const configFile = `${dnsmasqConfigFolder}/${this.featureName}_system.conf`;
    const dnsmasqEntry = `mac-address-tag=%FF:FF:FF:FF:FF:FF$!${this.featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async applyTag(tagUid) {
    if (this.tagSettings[tagUid] == 1)
      return this.perTagStart(tagUid);
    if (this.tagSettings[tagUid] == -1)
      return this.perTagStop(tagUid);
    return this.perTagReset(tagUid);
  }

  async applyNetwork(uuid) {
    if (this.networkSettings[uuid] == 1)
      return this.perNetworkStart(uuid);
    if (this.networkSettings[uuid] == -1)
      return this.perNetworkStop(uuid);
    return this.perNetworkReset(uuid);
  }

  async applyDevice(macAddress) {
    if (this.macAddressSettings[macAddress] == 1)
      return this.perDeviceStart(macAddress);
    if (this.macAddressSettings[macAddress] == -1)
      return this.perDeviceStop(macAddress);
    return this.perDeviceReset(macAddress);
  }

  async applyIdentity(guid) {
    if (this.identitySettings[guid] == 1)
      return this.perIdentityStart(guid);
    if (this.identitySettings[guid] == -1)
      return this.perIdentityStop(guid);
    return this.perIdentityReset(guid);
  }


  // TAG
  async perTagStart(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${this.featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${tagUid}$${this.featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagStop(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${this.featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${tagUid}$!${this.featureName}\n`; // match negative tag
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perTagReset(tagUid) {
    const configFile = `${dnsmasqConfigFolder}/tag_${tagUid}_${this.featureName}.conf`;
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  // NETWORK
  async perNetworkStart(uuid) {
    const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
    const iface = networkProfile && networkProfile.o && networkProfile.o.intf;
    if (!iface) {
      log.warn(`Interface name is not found on ${uuid}`);
      return;
    }
    const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${this.featureName}_${iface}.conf`;
    const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$${this.featureName}\n`;
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
    const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${this.featureName}_${iface}.conf`;
    // explicit disable family protect
    const dnsmasqEntry = `mac-address-tag=%00:00:00:00:00:00$!${this.featureName}\n`;
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
    const configFile = `${NetworkProfile.getDnsmasqConfigDirectory(uuid)}/${this.featureName}_${iface}.conf`;
    // remove config file
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  // DEVICE
  async perDeviceStart(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${this.featureName}_${macAddress}.conf`;
    const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$${this.featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceStop(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${this.featureName}_${macAddress}.conf`;
    const dnsmasqentry = `mac-address-tag=%${macAddress.toUpperCase()}$!${this.featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqentry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perDeviceReset(macAddress) {
    const configFile = `${dnsmasqConfigFolder}/${this.featureName}_${macAddress}.conf`;
    // remove config file
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  // IDENTITY
  async perIdentityStart(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${this.featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$${this.featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  }

  async perIdentityStop(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${this.featureName}.conf`;
      const dnsmasqEntry = `group-tag=@${identity.constructor.getEnforcementDnsmasqGroupId(uid)}$!${this.featureName}\n`;
      await fs.writeFileAsync(configFile, dnsmasqEntry);
      dnsmasq.scheduleRestartDNSService();
    }
  }

  async perIdentityReset(guid) {
    const identity = IdentityManager.getIdentityByGUID(guid);
    if (identity) {
      const uid = identity.getUniqueId();
      const configFile = `${dnsmasqConfigFolder}/${identity.constructor.getDnsmasqConfigFilenamePrefix(uid)}_${this.featureName}.conf`;
      await fs.unlinkAsync(configFile).catch((err) => { });
      dnsmasq.scheduleRestartDNSService();
    }
  }

  // global policy apply
  async applyPolicy(host, ip, policy) {
    log.info("Applying Unbound policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        if (policy && policy.state) {
          return await this.applyGlobalOn();
        } else {
          return await this.applyGlobalOff();
        }
      } else {
        if (!host)
          return;

        switch (host.constructor.name) {
          case "Tag": {
            const tagUid = host.o && host.o.uid;
            if (tagUid) {
              if (policy && policy.state === true)
                this.tagSettings[tagUid] = 1;
              if (policy && policy.state === false)
                this.tagSettings[tagUid] = 0;
              if (policy && policy.state === null)
                this.tagSettings[tagUid] = -1;
              await this.applyTag(tagUid);
            }
            break;
          }
          case "NetworkProfile": {
            const uuid = host.o && host.o.uuid;
            if (uuid) {
              if (policy && policy.state === true)
                this.networkSettings[uuid] = 1;
              if (policy && policy.state === false)
                this.networkSettings[uuid] = 0;
              if (policy && policy.state === null)
                this.networkettings[uuid] = -1;
              await this.applyNetwork(uuid);
            }
            break;
          }
          case "Host": {
            const macAddress = host && host.o && host.o.mac;
            if (macAddress) {
              if (policy && policy.state === true)
                this.macAddressSettings[macAddress] = 1;
              if (policy && policy.state === false)
                this.macAddressSettings[macAddress] = 0;
              if (policy && policy.state === null)
                this.macAddressSettings[macAddress] = -1;
              await this.applyDevice(macAddress);
            }
            break;
          }
          default:
            if (IdentityManager.isIdentity(host)) {
              const guid = IdentityManager.getGUID(host);
              if (guid) {
                if (policy && policy.state === true)
                  this.identitySettings[guid] = 1;
                if (policy && policy.state === false)
                  this.identitySettings[guid] = 0;
                if (policy && policy.state === null)
                  this.identitySettings[guid] = -1;
                await this.applyIdentity(guid);
              }
            }
        }
      }
    } catch (err) {
      log.error(`Got error when applying policy for feature ${this.config}, err:`, err.message);
    }
  }

  async getDNSServer() {
    const c = VPNClient.getClass(this.type);
    if (!c) {
      log.error("unsupported vpn client:", this.type);
      return;
    }

    const vpnClient = new c({this.profileId});
    const exists = await vpnClient.profileExists();
    if (!exists) {
      log.error("invalid profile id:", this.profileId);
      return;
    }

    const attributes = await vpnClient.getAttributes(false);
    if(attributes.remoteIP && attributes.dnsPort) {
      return `${attributes.remoteIP}#${attributes.dnsPort}`;
    } else {
      log.error("requiring remote ip and dns port, attrs:", attributes);
      return;
    }
  }

  async applyFeature(reCheckConfig = false) {
    log.debug("Apply unbound");
    const configFilePath = `${dnsmasqConfigFolder}/${this.featureName}.conf`;
    if (this.featureSwitch) {
      const server = await this.getDNSServer();
      log.info("DNS server is", server);
      const dnsmasqEntry = `server=${server}$${this.featureName}`;
      await fs.writeFileAsync(configFilePath, dnsmasqEntry);
    } else {
      await fs.unlinkAsync(configFilePath).catch((err) => { });
    }

    if (this.systemSwitch) {
      return this.applyGlobalOn();
    } else {
      return this.applyGlobalOff();
    }

    for (const macAddress in this.macAddressSettings) {
      await this.applyDevice(macAddress);
    }

    for (const tagUid in this.tagSettings) {
      const tag = TagManager.getTagByUid(tagUid);
      if (!tag)
        // reset tag if it is already deleted
        this.tagSettings[tagUid] = 0;
      await this.applyTag(tagUid);
      if (!tag)
        delete this.tagSettings[tagUid];
    }

    for (const uuid in this.networkSettings) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (!networkProfile)
        delete this.networkSettings[uuid];
      else
        await this.applyNetwork(uuid);
    }

    for (const guid in this.identitySettings) {
      const identity = IdentityManager.getIdentityByGUID(guid);
      if (!identity)
        delete this.identitySettings[guid];
      else
        await this.applyIdentity(guid);
    }
  }
}

module.exports = DockerDNS;
