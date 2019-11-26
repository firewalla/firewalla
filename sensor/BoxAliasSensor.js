/*    Copyright 2016 - 2019 Firewalla INC
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

    async installBoxAliases() {
        const aliases = [
            ["fire.walla", sysManager.myIp()],
            ["overlay.fire.walla", sysManager.myIp2()]
        ];

        let content = '';
        for (let alias of aliases) {
            if (alias[1]) {
                content += `address=/${alias[0]}/${alias[1]}\n`;
            }
        }

        await writeFileAsync(generatedConfigFile, content).then(() => {
            log.info(`generated ${generatedConfigFile}`);
            log.info(`added\n${content}`);
        }).catch((reason) => {
            log.error(`fail to write ${generatedConfigFile}: ${reason}`);
        });

        await dnsmasq.restartDnsmasq();
    }

    run() {
        this.installBoxAliases();

        sclient.on('message', (channel, message) => {
            switch (channel) {
                case 'System:IPChange':
                    this.installBoxAliases();
                    break;
                default:
                    break;
            }
        });
        sclient.subscribe('System:IPChange');
    }

}

module.exports = BoxAliasSensor;
