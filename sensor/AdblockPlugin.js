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

const sem = require('../sensor/SensorEventManager.js').getInstance();

const extensionManager = require('./ExtensionManager.js')

const f = require('../net2/Firewalla.js');

const userConfigFolder = f.getUserConfigFolder();
const dnsmasqConfigFolder = `${userConfigFolder}/dns`;
const updateInterval = 3600 * 1000 // once per hour

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const fc = require('../net2/config.js');

const spt = require('../net2/SystemPolicyTool')();

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
        const isPolicyEnabled = await spt.isPolicyEnabled('adblock');
        log.info('zhijie adblock', isPolicyEnabled)
        if (isPolicyEnabled) {
            await fc.enableDynamicFeature("adblock");
        }

        await exec(`mkdir -p ${dnsmasqConfigFolder}`);
        if (fc.isFeatureOn("adblock")) {
            this.globalOn();
        } else {
            this.globalOff();
        }
        fc.onFeature("adblock", async (feature, status) => {
            if (feature !== "adblock") {
                return;
            }
            if (status) {
                this.globalOn();
            } else {
                this.globalOff();
            }
        })

        this.job();
        this.timer = setInterval(async () => {
            return this.job();
        }, this.config.refreshInterval || 3600 * 1000); // one hour by default
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

    applySystemAdblock() {
        dnsmasq.controlFilter('adblock', this.adminSystemSwitch, this.systemSwitch ? "system" : "device");
    }

    async applyDeviceAdblock() {
        const macAddressArr = this.enabledMacAddresses;
        const configFile = `${dnsmasqConfigFolder}/adblock_mac_set.conf`;
        if (macAddressArr.length == 0) {
            await fs.unlink(configFile, err => {
                if (err) {
                    if (err.code === 'ENOENT') {
                        log.info(`Dnsmasq: No ${configFile}, skip remove`);
                    } else {
                        log.warn(`Dnsmasq: Error when remove ${configFile}`, err);
                    }
                }
            })
        } else {
            const adblocktagset = `mac-address-tag=%${macAddressArr.join("%")}$ad_block\n`;
            await fs.writeFile(configFile, adblocktagset);
        }
        dnsmasq.controlFilter('adblock', this.adminSystemSwitch, this.systemSwitch ? "system" : "device");
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
