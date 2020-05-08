/*    Copyright 2020 Firewalla INC 
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
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const dnsmasq = new DNSMASQ();
const featureName = 'local_domain';
const f = require('../net2/Firewalla.js');
const FILTER_DIR = f.getUserConfigFolder() + "/dnsmasq";
const ADDN_HOSTS_CONF = FILTER_DIR + "/addn_hosts.conf";
const HOSTS_DIR = f.getRuntimeInfoFolder() + "/hosts";
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;

class LocalDomainSensor extends Sensor {
    constructor() {
        super();
    }
    async run() {
        this.hookFeature(featureName);
        sem.on('LocalDomainUpdate', async (event) => {
            const macArr = event.macArr || [];
            if (macArr.includes('0.0.0.0')) {
                await this.localDomainSuffixUpdate();
                return;
            }
            for (const mac of macArr) {
                const host = await hostManager.getHostAsync(mac);
                await host.updateHostsFile().catch((err) => {
                    log.error(`Failed to update hosts file for ${host.o.mac}`, err.messsage);
                });
            }
        });
    }
    async globalOn() {
        await exec(`mkdir -p ${HOSTS_DIR}`);
        await fs.writeFileAsync(ADDN_HOSTS_CONF, "addn-hosts=" + HOSTS_DIR);
        dnsmasq.scheduleRestartDNSService();
        const hosts = await hostManager.getHostsAsync();
        for (const host of hosts) {
            if (host && host.o && host.o.mac) {
                await host.updateHostsFile().catch((err) => {
                    log.error(`Failed to update hosts file for ${host.o.mac}`, err.messsage);
                });
            }
        }
    }
    async globalOff() {
        try {
            await fs.unlinkAsync(ADDN_HOSTS_CONF);
            dnsmasq.scheduleRestartDNSService();
        } catch (err) {
            if (err.code === 'ENOENT') {
                log.info(`Dnsmasq: No ${ADDN_HOSTS_CONF}, skip remove`);
            } else {
                log.warn(`Dnsmasq: Error when remove ${ADDN_HOSTS_CONF}`, err);
            }
        }
    }
    async localDomainSuffixUpdate() {
        const hosts = await hostManager.getHostsAsync();
        for (const host of hosts) {
            if (host && host.o && host.o.mac) {
                await host.updateHostsFile().catch((err) => {
                    log.error(`Failed to update hosts file for ${host.o.mac}`, err.messsage);
                });
            }
        }
    }
}

module.exports = LocalDomainSensor;
