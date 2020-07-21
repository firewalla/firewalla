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
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const featureName = "device_service_scan";
const policyKeyName = "device_service_scan";
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const rclient = require('../util/redis_manager.js').getRedisClient();
const sysManager = require('../net2/SysManager.js');
const cp = require('child_process');
const util = require('util');
const Firewalla = require('../net2/Firewalla');
const xml2jsonBinary = Firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + Firewalla.getPlatform();

class DeviceServiceScanSensor extends Sensor {
    async run() {
        this.systemSwitch = false;
        this.adminSystemSwitch = false;
        this.deviceScanMap = {};
        this.tagScanMap = {};
        this.networkScanMap = {};
        this.systemScanTimer = '';
        this.interval = this.config.interval * 1000 || 30 * 60 * 1000; // 30 minutes
        extensionManager.registerExtension(policyKeyName, this, {
            applyPolicy: this.applyPolicy
        });
        this.hookFeature(featureName);
    }

    async job() {
        await this.applyScan();
    }

    async apiRun() {
    }

    async applyPolicy(host, ip, policy) {
        log.info("Applying device service scan policy:", ip, policy);
        try {
            if (ip === '0.0.0.0') {
                if (policy === true) {
                    this.systemSwitch = true;
                } else {
                    this.systemSwitch = false;
                }
                return this.applySystemScan();
            } else {
                if (!host)
                    return;
                switch (host.constructor.name) {
                    case "Tag": {
                        const tagUid = host.o && host.o.uid;
                        if (tagUid) {
                            const hosts = await hostManager.getHostsAsync();
                            const tagHosts = hosts.filter((h) => {
                                return h && h.o && h.o.tags && (
                                    h.o.tags.includes(Number(tagUid)) || h.o.tags.includes(String(tagUid))
                                )
                            })
                            if (this.tagScanMap[tagUid]) {
                                this.tagScanMap[tagUid] = Object.assign(this.tagScanMap[tagUid], {
                                    hosts: tagHosts,
                                    policy: policy
                                })
                            } else {
                                this.tagScanMap[tagUid] = {
                                    hosts: tagHosts,
                                    policy: policy
                                }
                            }

                            await this.applyDeviceScan(this.tagScanMap[tagUid]);
                        }
                        break;
                    }
                    case "NetworkProfile": {
                        const uuid = host.o && host.o.uuid;
                        if (uuid) {
                            const hosts = await hostManager.getHostsAsync();
                            const networkHosts = hosts.filter((h) => {
                                return h && h.o && h.o.intf_uuid == uuid
                            })
                            if (this.networkScanMap[uuid]) {
                                this.networkScanMap[uuid] = Object.assign(this.networkScanMap[uuid], {
                                    hosts: networkHosts,
                                    policy: policy
                                })
                            } else {
                                this.networkScanMap[uuid] = {
                                    hosts: networkHosts,
                                    policy: policy
                                }
                            }
                            await this.applyDeviceScan(this.networkScanMap[uuid]);
                        }
                        break;
                    }
                    case "Host": {
                        const macAddress = host && host.o && host.o.mac;
                        if (macAddress) {
                            if (this.deviceScanMap[macAddress]) {
                                this.deviceScanMap[macAddress] = Object.assign(this.deviceScanMap[macAddress], {
                                    hosts: [host],
                                    policy: policy
                                })
                            } else {
                                this.deviceScanMap[macAddress] = {
                                    hosts: [host],
                                    policy: policy
                                }
                            }
                            await this.applyDeviceScan(this.deviceScanMap[macAddress]);
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

    async applyScan() {
        this.applySystemScan();
        for (const mac in this.deviceScanMap) {
            const scanInfo = this.deviceScanMap(mac);
            await this.applyDeviceScan(scanInfo);
        }
        for (const tagUid in this.tagScanMap) {
            const scanInfo = this.tagScanMap(tagUid);
            await this.applyDeviceScan(scanInfo);
        }
        for (const uuid in this.networkScanMap) {
            const scanInfo = this.networkScanMap(uuid);
            await this.applyDeviceScan(scanInfo);
        }
    }

    async applySystemScan() {
        this.systemScanTimer && clearInterval(this.systemScanTimer);
        if (this.systemSwitch && this.adminSystemSwitch) {
            const hosts = await hostManager.getHostsAsync();
            await this.scan(hosts);
            this.systemScanTimer = setInterval(() => {
                this.scan(hosts);
            }, this.interval);
        }
    }
    async applyDeviceScan(scanInfo) {
        if (!scanInfo) return;
        scanInfo.timer && clearInterval(scanInfo.timer);
        if (this.adminSystemSwitch && scanInfo.policy) {
            await this.scan(scanInfo.hosts);
            scanInfo.timer = setInterval(() => {
                this.scan(scanInfo.hosts);
            }, this.interval);
        }
    }

    async scan(hosts) {
        log.info('Scan start...');
        if (!hosts)
            throw new Error('Failed to scan.');
        try {
            hosts = hosts.filter((host) => host && host.o && host.o.mac && host.o.ipv4Addr && !sysManager.isMyIP(host.o.ipv4Addr));
            for (const host of hosts) {
                log.info("Scanning device: ", host.o.ipv4Addr);
                try {
                    const scanResult = await this._scan(host.o.ipv4Addr);
                    if (scanResult) {
                        await rclient.hsetAsync("host:mac:" + host.o.mac, "openports", JSON.stringify(scanResult));
                    }
                } catch (e) {
                    log.info('host port scan error', e);
                }
            }
        } catch (err) {
            log.error("Failed to scan: " + err);
        }
        log.info('Scan finished...');
    }
    _scan(ipAddr) {
        let cmd = util.format('sudo nmap -Pn --top-ports 3000 %s -oX - | %s', ipAddr, xml2jsonBinary);
        log.info("Running command:", cmd);
        return new Promise((resolve, reject) => {
            cp.exec(cmd, (err, stdout, stderr) => {
                if (err || stderr) {
                    reject(err || new Error(stderr));
                    return;
                }

                let findings = null;
                try {
                    findings = JSON.parse(stdout);
                } catch (err) {
                    reject(err);
                }
                let nmapJSON = findings && findings.nmaprun && findings.nmaprun.host;
                resolve(this._parseNmapPortResult(nmapJSON));
            })
        });
    }

    static _handlePortEntry(portJson, openports) {
        if (portJson) {
            if (!openports[portJson.protocol])
                openports[portJson.protocol] = [];
            openports[portJson.protocol].push(portJson.portid * 1);
        }
    }

    _parseNmapPortResult(nmapResult) {
        let openports = {};
        openports.lastActiveTimestamp = Date.now() / 1000;
        try {
            let port = nmapResult && nmapResult.ports && nmapResult.ports.port;
            if (port && port.constructor === Object) {
                // one port only
                DeviceServiceScanSensor._handlePortEntry(port, openports);
            } else if (port && port.constructor === Array) {
                // multiple ports
                port.forEach((p) => DeviceServiceScanSensor._handlePortEntry(p, openports));
            }
        } catch (err) {
            log.error("Failed to parse nmap host: " + err);
        }
        return openports;
    }

    // global on/off
    async globalOn() {
        this.adminSystemSwitch = true;
        this.applyScan();
    }

    async globalOff() {
        this.adminSystemSwitch = false;
        this.applyScan();
    }
}

module.exports = DeviceServiceScanSensor
