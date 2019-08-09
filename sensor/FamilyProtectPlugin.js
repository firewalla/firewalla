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

const FAMILY_DNS = ["8.8.8.8"]; // these are just backup servers
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const exec = require('child-process-promise').exec;

const fc = require('../net2/config.js');

const spt = require('../net2/SystemPolicyTool')();
const rclient = require('../util/redis_manager.js').getRedisClient();
const updateFeature = "family";
const updateFlag = "2";

class FamilyProtectPlugin extends Sensor {
    async run() {
        this.systemSwitch = false;
        this.adminSystemSwitch = false;
        this.enabledMacAddresses = {};
        extensionManager.registerExtension("family", this, {
            applyPolicy: this.applyPolicy,
            start: this.start,
            stop: this.stop
        });
        if (await rclient.hgetAsync("sys:upgrade", updateFeature) != updateFlag) {
            const isPolicyEnabled = await spt.isPolicyEnabled('family');
            if (isPolicyEnabled) {
                await fc.enableDynamicFeature("family");
            }
            await rclient.hsetAsync("sys:upgrade", updateFeature, updateFlag)
        }
        await exec(`mkdir -p ${dnsmasqConfigFolder}`);
        sem.once('IPTABLES_READY', async () => {
            if (fc.isFeatureOn("family_protect")) {
                await this.globalOn();
            } else {
                await this.globalOff();
            }
            fc.onFeature("family_protect", async (feature, status) => {
                if (feature !== "family_protect") {
                    return;
                }
                if (status) {
                    await this.globalOn();
                } else {
                    await this.globalOff();
                }
            })

            await this.job();
            this.timer = setInterval(async () => {
                return this.job();
            }, this.config.refreshInterval || 3600 * 1000); // one hour by default
        })
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
                    if (fc.isFeatureOn("family_protect", true)) {//compatibility: new firewlla, old app
                        await fc.enableDynamicFeature("family_protect");
                    }
                } else {
                    this.systemSwitch = false;
                }
                return this.applySystemFamilyProtect();
            } else {
                const macAddress = host && host.o && host.o.mac;
                if (macAddress) {
                    if (policy == true) {
                        this.enabledMacAddresses[macAddress] = 1;
                    } else {
                        delete this.enabledMacAddresses[macAddress];
                    }
                    return this.applyDeviceFamilyProtect(macAddress);
                }
            }
        } catch (err) {
            log.error("Got error when applying family protect policy", err);
        }
    }

    async applyFamilyProtect() {
        await this.applySystemFamilyProtect();
        for (const macAddress in this.enabledMacAddresses) {
            await this.applyDeviceFamilyProtect(macAddress);
        }
    }

    async applySystemFamilyProtect() {
        this.familyDnsAddr((err, dnsaddrs) => {
            if (this.systemSwitch && this.adminSystemSwitch) {
                return this.systemStart(dnsaddrs);
            } else {
                return this.systemStop(dnsaddrs);
            }
        });
    }

    async applyDeviceFamilyProtect(macAddress) {
        this.familyDnsAddr((err, dnsaddrs) => {
            try {
                if (this.enabledMacAddresses[macAddress] && this.adminSystemSwitch) {
                    return this.perDeviceStart(macAddress, dnsaddrs)
                } else {
                    return this.perDeviceStop(macAddress, dnsaddrs);
                }
            } catch (err) {
                log.error(`Failed to apply family protect on device ${macAddress}, err: ${err}`);
            }
        });
    }

    async systemStart(dnsaddrs) {
        dnsmasq.setDefaultNameServers("family", dnsaddrs);
        dnsmasq.updateResolvConf();
    }

    async systemStop() {
        dnsmasq.unsetDefaultNameServers("family"); // reset dns name servers to null no matter whether iptables dns change is failed or successful
        dnsmasq.updateResolvConf();
    }

    async perDeviceStart(macAddress, dnsaddrs) {
        const configFile = `${dnsmasqConfigFolder}/familyProtect_${macAddress}.conf`;
        const dnsmasqentry = `server=${dnsaddrs[0]}%${macAddress.toUpperCase()}\n`;
        await fs.writeFileAsync(configFile, dnsmasqentry);
        dnsmasq.restartDnsmasq();
    }

    async perDeviceStop(macAddress) {
        const configFile = `${dnsmasqConfigFolder}/familyProtect_${macAddress}.conf`;
        try {
            await fs.unlinkAsync(configFile);
        } catch (err) {
            if (err.code === 'ENOENT') {
                log.info(`Dnsmasq: No ${configFile}, skip remove`);
            } else {
                log.warn(`Dnsmasq: Error when remove ${configFile}`, err);
            }
        }
        dnsmasq.restartDnsmasq();
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

    familyDnsAddr(callback) {
        f.getBoneInfo((err, data) => {
            if (data && data.config && data.config.dns && data.config.dns.familymode) {
                callback(null, data.config.dns.familymode);
            } else {
                callback(null, FAMILY_DNS);
            }
        });
    }
}

module.exports = FamilyProtectPlugin
