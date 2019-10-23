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

const sclient = require('../util/redis_manager.js').getSubscriptionClient();

const util = require('util');
const fs = require('fs');
const writeFileAsync = util.promisify(fs.writeFile);
const unlinkFileAsync = util.promisify(fs.unlink);

const DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
const dnsmasq = new DNSMASQ();

const SysManager = require('../net2/SysManager.js');
const sysManager = new SysManager('info');

const f = require('../net2/Firewalla.js');
const generatedConfigFile = `${f.getUserConfigFolder()}/dnsmasq/box_alias.generated`;

class BoxAliasSensor extends Sensor {

    async installBoxAlias() {
        const ip = sysManager.myIp();
        if (ip) {
            const entry = `address=/fire.walla/${ip}\n`;
            await writeFileAsync(generatedConfigFile, entry)
                .then(() => {
                    log.info(`generated ${generatedConfigFile}`);
                    log.info(`added ${entry}`);
                })
                .catch((reason) => {
                    log.error(`fail to write ${this.generatedConfigFile}`);
                });
        } else {
            await unlinkFileAsync(generatedConfigFile)
                .catch(() => {
                    log.info(`cleanup ${generatedConfigFile}`);
                })
                .catch((reason) => {
                });
        }
        await dnsmasq.restartDnsmasq();
    }

    run() {
        this.installBoxAlias();

        sclient.on('message', (channel, message) => {
            switch (channel) {
                case 'System:IPChange':
                    this.installBoxAlias();
                    break;
                default:
                    break;
            }
        });
        sclient.subscribe('System:IPChange');
    }

}

module.exports = BoxAliasSensor;