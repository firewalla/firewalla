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
const hostManager = new HostManager("cli", 'client', 'info');
const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();
const featureName = 'local_domain';
const f = require('../net2/Firewalla.js');
const FILTER_DIR = f.getUserConfigFolder() + "/dnsmasq";
const LOCAL_DOMAIN_FILE = FILTER_DIR + "/local_device_domain.conf";
const util = require('util');
const fs = require('fs');
const unlinkAsync = util.promisify(fs.unlink);
const HostTool = require('../net2/HostTool.js')
const hostTool = new HostTool();
class LocalDomainSensor extends Sensor {
    constructor() {
        super();
    }
    run() {
        this.hookFeature(featureName);
    }
    async globalOn() {
        const hosts = await hostManager.getHostsAsync();
        let pureHosts = [];
        for (const host of hosts) {
            if (host && host.o) {
                pureHosts.push(host.o)
            }
        }
        const promises = pureHosts.map(async (host) => {
            await hostTool.generateLocalDomain(host);
        })
        await Promise.all(promises);
        await dnsmasq.setupLocalDeviceDomain(pureHosts);
        dnsmasq.restartDnsmasq();
    }
    async globalOff() {
        try {
            await unlinkAsync(LOCAL_DOMAIN_FILE);
            dnsmasq.restartDnsmasq();
        } catch (err) {
            if (err.code === 'ENOENT') {
                log.info(`Dnsmasq: No ${LOCAL_DOMAIN_FILE}, skip remove`);
            } else {
                log.warn(`Dnsmasq: Error when remove ${LOCAL_DOMAIN_FILE}`, err);
            }
        }
    }
}

module.exports = LocalDomainSensor;
