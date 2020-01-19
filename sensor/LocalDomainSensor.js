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
const sem = require('../sensor/SensorEventManager.js').getInstance();
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
const updateFlag = "1";
const rclient = require('../util/redis_manager.js').getRedisClient();

class LocalDomainSensor extends Sensor {
    constructor() {
        super();
        this.newFeature = false;
    }
    async run() {
        if (await rclient.hgetAsync("sys:upgrade", featureName) != updateFlag) {
            this.newFeature = true;
            await rclient.hsetAsync("sys:upgrade", featureName, updateFlag)
        }
        this.hookFeature(featureName);
        sem.on('LocalDomainUpdate', async (event) => {
            const macArr = event.macArr;
            await dnsmasq.setupLocalDeviceDomain(macArr, true);
        });
    }
    async globalOn() {
        const hosts = await hostManager.getHostsAsync();
        let macArr = [];
        for (const host of hosts) {
            if (host && host.o && host.o.mac) {
                macArr.push(host.o.mac)
            }
        }
        if (this.newFeature) {
            const promises = macArr.map(async (mac) => {
                await hostTool.generateLocalDomain(mac);
            })
            await Promise.all(promises);
        }
        await dnsmasq.setupLocalDeviceDomain(macArr, true);
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
