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

class FamilyProtectPlugin extends Sensor {
    async run() {
        log.info("FamilyProtectPlugin run")
        this.systemSwitch = false;
        this.adminSystemSwitch = false;
        this.enabledMacAddresses = {};
        extensionManager.registerExtension("familyProtect", this, {
            applyPolicy: this.applyPolicy
        });
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

            sem.on('FAMILYPROTECT_REFRESH', (event) => {
                this.applyFamilyProtect();
            });

            if (f.isMain()) {
                setInterval(() => {
                    this.checkIfRestartNeeded()
                }, 10 * 1000) // check restart request once every 10 seconds
            }

            await this.job();
            this.timer = setInterval(async () => {
                return this.job();
            }, this.config.refreshInterval || 3600 * 1000); // one hour by default
        })
    }

    async checkIfRestartNeeded() {
        const MIN_RESTART_INTERVAL = 10; // 10 seconds
        if (this.needRestart) {
            log.info("need restart is", this.needRestart);
        }

        if (this.needRestart && (new Date() / 1000 - this.needRestart) > MIN_RESTART_INTERVAL) {
            this.needRestart = null
            await this._rawRestartDeviceMasq().then(() => {
                log.info("dnsmasq is restarted successfully");
            }).catch((err) => {
                log.error("Failed to restart devicemasq", err);
            })
        }
    }

    async job() {
        await this.applyFamilyProtect();
    }

    async apiRun() {

    }

    async applyPolicy(host, ip, policy) {
        log.info("Applying policy:", ip, policy);
        try {
            if (ip === '0.0.0.0') {
                if (policy == true) {
                    this.systemSwitch = true;
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
        log.info("Applying family protect on device", macAddress);
        this.familyDnsAddr((err, dnsaddrs) => {
            try {
                if (this.enabledMacAddresses[macAddress]) {
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

    async systemStop(dnsaddrs) {
        dnsmasq.unsetDefaultNameServers("family"); // reset dns name servers to null no matter whether iptables dns change is failed or successful
        dnsmasq.updateResolvConf();
    }
    restartDeviceMasq() {
        if (!this.needRestart) {
            this.needRestart = new Date() / 1000;
        }
    }

    async _rawRestartDeviceMasq() {
        return exec("sudo systemctl restart dnsmasq");
    }

    async perDeviceStart(macAddress, dnsaddrs) {
        const configFile = `${dnsmasqConfigFolder}/familyProtect_${macAddress}.conf`;
        const dnsmasqentry = `server=${dnsaddrs[0]}%${macAddress.toUpperCase()}\n`;
        await fs.writeFile(configFile, dnsmasqentry);
        await this.delay(8 * 1000); // wait for a while before activating the dns redirect
    }

    async perDeviceStop(macAddress, dnsaddrs) {
        const configFile = `${dnsmasqConfigFolder}/familyProtect_${macAddress}.conf`;
        await fs.unlink(configFile, err => {
            if (err) {
                if (err.code === 'ENOENT') {
                    log.info(`Dnsmasq: No ${configFile}, skip remove`);
                } else {
                    log.warn(`Dnsmasq: Error when remove ${configFile}`, err);
                }
            }
        })
        this.restartDeviceMasq();
    }

    // global on/off
    async globalOn() {
        this.adminSystemSwitch = true;
        await this.applySystemFamilyProtect();
    }

    async globalOff() {
        this.adminSystemSwitch = false;
        await this.applySystemFamilyProtect();
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
