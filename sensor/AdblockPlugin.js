/*    Copyright 2016 Firewalla LLC
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
const deviceConfigFile = `${dnsmasqConfigFolder}/adblock_mac_set.conf`;
const systemConfigFile = `${dnsmasqConfigFolder}/adblock_system.conf`;
const dnsTag = "$ad_block";
const systemLevelMac = "FF:FF:FF:FF:FF:FF";

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const fc = require('../net2/config.js');

const spt = require('../net2/SystemPolicyTool')();
const rclient = require('../util/redis_manager.js').getRedisClient();
const updateFeature = "adblock";
const updateFlag = "2";

const featureName = "adblock";

class AdblockPlugin extends Sensor {
    async run() {
        this.systemSwitch = false;
        this.adminSystemSwitch = false;
        this.enabledMacAddresses = [];
        extensionManager.registerExtension("adblock", this, {
            applyPolicy: this.applyPolicy,
            start: this.start,
            stop: this.stop
        });
        if (await rclient.hgetAsync("sys:upgrade", updateFeature) != updateFlag) {
            const isPolicyEnabled = await spt.isPolicyEnabled('adblock');
            if (isPolicyEnabled) {
                await fc.enableDynamicFeature("adblock");
            }
            await rclient.hsetAsync("sys:upgrade", updateFeature, updateFlag)
        }

        await exec(`mkdir -p ${dnsmasqConfigFolder}`);
        this.hookFeature(featureName);
    }

    job() {
        this.applyAdblock();
    }

    async apiRun() {
    }

    async applyPolicy(host, ip, policy) {
        log.info("Applying adblock policy:", ip, policy);
        try {
            if (ip === '0.0.0.0') {
                if (policy == true) {
                    this.systemSwitch = true;
                    if (fc.isFeatureOn("adblock", true)) {//compatibility: new firewlla, old app
                        await fc.enableDynamicFeature("adblock");
                        return;
                    }
                } else {
                    this.systemSwitch = false;
                }
                return this.applySystemAdblock();
            } else {
                const macAddress = host && host.o && host.o.mac;
                if (macAddress) {
                    if (policy == true) {
                        this.enabledMacAddresses.push(macAddress);
                    } else {
                        const index = this.enabledMacAddresses.indexOf(macAddress);
                        if (index > -1) {
                            this.enabledMacAddresses.splice(index, 1);
                        }
                    }
                    return this.applyDeviceAdblock();
                }
            }
        } catch (err) {
            log.error("Got error when applying adblock policy", err);
        }
    }

    applyAdblock() {
        this.applySystemAdblock();
        this.applyDeviceAdblock();
    }

    async applySystemAdblock() {
        if (this.systemSwitch && this.adminSystemSwitch) {
            const adblocktagset = `mac-address-tag=%${systemLevelMac}${dnsTag}\n`;
            await fs.writeFileAsync(systemConfigFile, adblocktagset);
        } else {
            try {
                await fs.unlinkAsync(systemConfigFile);
            } catch (err) {
                if (err.code === 'ENOENT') {
                    log.info(`Dnsmasq: No ${systemConfigFile}, skip remove`);
                } else {
                    log.warn(`Dnsmasq: Error when remove ${systemConfigFile}`, err);
                }
            }
        }
        dnsmasq.controlFilter('adblock', this.adminSystemSwitch);
    }

    async applyDeviceAdblock() {
        const macAddressArr = this.enabledMacAddresses;
        if (macAddressArr.length > 0 && this.adminSystemSwitch) {
            let adblocktagset = "";
            macAddressArr.forEach((macAddress) => {
                adblocktagset += `mac-address-tag=%${macAddress}${dnsTag}\n`
            })
            await fs.writeFileAsync(deviceConfigFile, adblocktagset);
        } else {
            try {
                await fs.unlinkAsync(deviceConfigFile);
            } catch (err) {
                if (err.code === 'ENOENT') {
                    log.info(`Dnsmasq: No ${deviceConfigFile}, skip remove`);
                } else {
                    log.warn(`Dnsmasq: Error when remove ${deviceConfigFile}`, err);
                }
            }
        }
        dnsmasq.restartDnsmasq();
    }
    // global on/off
    globalOn() {
        this.adminSystemSwitch = true;
        this.applyAdblock();
    }

    globalOff() {
        this.adminSystemSwitch = false;
        this.applyAdblock();
    }
}

module.exports = AdblockPlugin
