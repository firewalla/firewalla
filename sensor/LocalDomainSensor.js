/*    Copyright 2019 Firewalla INC 
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
const LOCAL_DEVICE_DOMAIN = FILTER_DIR + "/local_device_domain.conf";
const util = require('util');
const fs = require('fs');
const unlinkAsync = util.promisify(fs.unlink);
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
        log.debug("pureHosts", pureHosts)
        await dnsmasq.setupLocalDeviceDomain(pureHosts, true);
    }
    async globalOff() {
        try {
            await unlinkAsync(LOCAL_DEVICE_DOMAIN);
            dnsmasq.restartDnsmasq();
        } catch (err) {
            if (err.code === 'ENOENT') {
                log.info(`Dnsmasq: No ${LOCAL_DEVICE_DOMAIN}, skip remove`);
            } else {
                log.warn(`Dnsmasq: Error when remove ${LOCAL_DEVICE_DOMAIN}`, err);
            }
        }
    }
}

module.exports = LocalDomainSensor;
