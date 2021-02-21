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
const sem = require('../sensor/SensorEventManager.js').getInstance();

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dnsmasq`;

const NetworkProfileManager = require('../net2/NetworkProfileManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const TagManager = require('../net2/TagManager.js');
const VPNProfileManager = require('../net2/VPNProfileManager.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const featureName = "doh";
const fc = require('../net2/config.js');

const dc = require('../extension/dnscrypt/dnscrypt');

class DNSCryptPlugin extends Sensor {
  async run() {
    this.refreshInterval = (this.config.refreshInterval || 24 * 60) * 60 * 1000;
    this.systemSwitch = false;
    this.adminSystemSwitch = false;
    this.networkSettings = {};
    this.tagSettings = {};
    this.macAddressSettings = {};
    this.vpnProfileSettings = {};

    extensionManager.registerExtension(featureName, this, {
      applyPolicy: this.applyPolicy,
      start: this.start,
      stop: this.stop
    });

    await exec(`mkdir -p ${dnsmasqConfigFolder}`);

    this.hookFeature(featureName);

    sem.on('DOH_REFRESH', (event) => {
      this.applyDoH();
    });
  }

  async job() {
    await this.applyDoH(true);
  }

  async apiRun() {
    extensionManager.onSet("dohConfig", async (msg, data) => {
      if (data && data.servers) {
        await dc.setServers(data.servers, false)
        sem.sendEventToFireMain({
          type: 'DOH_REFRESH'
        });
      }
    });

    extensionManager.onSet("customizedDohServers", async (msg, data) => {
      if (data && data.servers) {
        await dc.setServers(data.servers, true);
      }
    });

    extensionManager.onGet("dohConfig", async (msg, data) => {
      const selectedServers = await dc.getServers();
      const customizedServers = await dc.getCustomizedServers();
      const allServers = await dc.getAllServerNames();
      return {
        selectedServers, allServers, customizedServers
      }
    });
  }

  // global policy apply
  async applyPolicy(host, ip, policy) {
    log.info("Applying DoH policy:", ip, policy);
    try {
      if (ip === '0.0.0.0') {
        if (policy && policy.state) {
          this.systemSwitch = true;
        } else {
          this.systemSwitch = false;
        }
        return this.applySystemDoH();
      } else {
        if (!host)
          return;
        switch (host.constructor.name) {
          case "Tag": {
            const tagUid = host.o && host.o.uid;
            if (tagUid) {
              if (policy && policy.state === true)
                this.tagSettings[tagUid] = 1;
              // false means unset, this is for backward compatibility
              if (policy && policy.state === false)
                this.tagSettings[tagUid] = 0;
              // null means disabled, this is for backward compatibility
              if (policy && policy.state === null)
                this.tagSettings[tagUid] = -1;
              await this.applyTagDoH(tagUid);
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
                this.networkSettings[uuid] = -1;
              await this.applyNetworkDoH(uuid);
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
              await this.applyDeviceDoH(macAddress);
            }
            break;
          }
          case "VPNProfile": {
            const cn = host.o && host.o.cn;
            if (cn) {
              if (policy && policy.state === true)
                this.vpnProfileSettings[cn] = 1;
              // false means unset, this is for backward compatibility
              if (policy && policy.state === false)
                this.vpnProfileSettings[cn] = 0;
              // null means disabled, this is for backward compatibility
              if (policy && policy.state === null)
                this.vpnProfileSettings[cn] = -1;
              await this.applyVPNProfileDoH(cn);
            }
            break;
          }
          default:
        }
      }
    } catch (err) {
      log.error("Got error when applying DoH policy", err);
    }
  }

  async applyDoH(reCheckConfig = false) {
    if (!fc.isFeatureOn(featureName)) {
      await dc.stop();
    } else {
      const result = await dc.prepareConfig({}, reCheckConfig);
      if (result) {
        await dc.restart();
      } else {
        await dc.start();
      }
    }
    const configFilePath = `${dnsmasqConfigFolder}/${featureName}.conf`;
    if (this.adminSystemSwitch) {
      const dnsmasqEntry = `server=${dc.getLocalServer()}$${featureName}`;
      await fs.writeFileAsync(configFilePath, dnsmasqEntry);
    } else {
      await fs.unlinkAsync(configFilePath).catch((err) => { });
    }

    await this.applySystemDoH();
    for (const macAddress in this.macAddressSettings) {
      await this.applyDeviceDoH(macAddress);
    }
    for (const tagUid in this.tagSettings) {
      const tag = TagManager.getTagByUid(tagUid);
      if (!tag)
        // reset tag if it is already deleted
        this.tagSettings[tagUid] = 0;
      await this.applyTagDoH(tagUid);
      if (!tag)
        delete this.tagSettings[tagUid];
    }
    for (const uuid in this.networkSettings) {
      const networkProfile = NetworkProfileManager.getNetworkProfile(uuid);
      if (!networkProfile)
        delete this.networkSettings[uuid];
      else
        await this.applyNetworkDoH(uuid);
    }
    for (const cn in this.vpnProfileSettings) {
      const vpnProfile = VPNProfileManager.getVPNProfile(cn);
      if (!vpnProfile)
        delete this.vpnProfileSettings[cn];
      else
        await this.applyVPNProfileDoH(cn);
    }
  }

  async applySystemDoH() {
    if (this.systemSwitch) {
      return this.systemStart();
    } else {
      return this.systemStop();
    }
  }

  async applyTagDoH(tagUid) {
    if (this.tagSettings[tagUid] == 1)
      return this.perTagStart(tagUid);
    if (this.tagSettings[tagUid] == -1)
      return this.perTagStop(tagUid);
    return this.perTagReset(tagUid);
  }

  async applyNetworkDoH(uuid) {
    if (this.networkSettings[uuid] == 1)
      return this.perNetworkStart(uuid);
    if (this.networkSettings[uuid] == -1)
      return this.perNetworkStop(uuid);
    return this.perNetworkReset(uuid);
  }

  async applyDeviceDoH(macAddress) {
    if (this.macAddressSettings[macAddress] == 1)
      return this.perDeviceStart(macAddress);
    if (this.macAddressSettings[macAddress] == -1)
      return this.perDeviceStop(macAddress);
    return this.perDeviceReset(macAddress);
  }

  async applyVPNProfileDoH(cn) {
    if (this.vpnProfileSettings[cn] == 1)
      return this.perVPNProfileStart(cn);
    if (this.vpnProfileSettings[cn] == -1)
      return this.perVPNProfileStop(cn);
    return this.perVPNProfileReset(cn);
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
    await fs.unlinkAsync(configFile).catch((err) => { });
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
    await fs.unlinkAsync(configFile).catch((err) => { });
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
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  async perVPNProfileStart(cn) {
    const configFile = `${dnsmasqConfigFolder}/vpn_prof_${cn}_${featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${cn}$${featureName}\n`;
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perVPNProfileStop(cn) {
    const configFile = `${dnsmasqConfigFolder}/vpn_prof_${cn}_${featureName}.conf`;
    const dnsmasqEntry = `group-tag=@${cn}$!${featureName}\n`; // match negative tag
    await fs.writeFileAsync(configFile, dnsmasqEntry);
    dnsmasq.scheduleRestartDNSService();
  }

  async perVPNProfileReset(cn) {
    const configFile = `${dnsmasqConfigFolder}/vpn_prof_${cn}_${featureName}.conf`;
    await fs.unlinkAsync(configFile).catch((err) => { });
    dnsmasq.scheduleRestartDNSService();
  }

  // global on/off
  async globalOn() {
    this.adminSystemSwitch = true;
    await this.applyDoH();
  }

  async globalOff() {
    this.adminSystemSwitch = false;
    await this.applyDoH();
  }
}

module.exports = DNSCryptPlugin;
