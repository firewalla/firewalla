/*    Copyright 2020 Firewalla LLC
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
const exec = require('child-process-promise').exec;
const { date } = require('later');
const extensionManager = require('./ExtensionManager.js')
const sysManager = require('../net2/SysManager.js');

let erh = null;
let era = null;
let ea = require('../event/EventApi.js');

class EventSensor extends Sensor {

    async apiRun() {

        extensionManager.onGet("events", async (msg, data) => {
            try {
                log.info(`processing onGet events with data(${JSON.stringify(data)})`);
                let result = await ea.listEvents(data.begin,data.end,data.limit_offset,data.limit_count);
                return result;
            } catch (err) {
                log.error(`failed to list events with ${JSON.stringify(data)}, ${err}`);
            }
        });

    }

    async run() {
        log.info("run EventSensor")
        erh = require('../event/EventRequestHandler.js')
        era = require('../event/EventRequestApi.js');
        setTimeout(() => {
                this.scheduledJob();
                setInterval(() => { this.scheduledJob(); }, 1000 * 60 ); // run every minute
            },
            1000 * 5
        ); // first time in 5 seconds
    }

    async scheduledJob() {
        try {
            log.info("Start monitoring and generate events if needed")
            await this.networkUpDown();
            await this.pingGateway();
            log.info("scheduledJob is executed successfully");
        } catch(err) {
            log.error("Failed to run scheduled job, err:", err);
        }
    }

    async networkUpDown() {
        for (let i=0;i<4;i++) {
            const ethx=`eth${i}`;
            log.info(`checking network state of ${ethx}`);
            try {
                const result = await exec(`sudo ethtool ${ethx} | awk '/Link detected:/ {print $3}'`);
                log.info("result: ",result.stdout);
                switch ( result.stdout.replace(/\n$/,'') ) {
                    case "yes":
                        era.addStateEvent("network",ethx,1);
                        break;
                    case "no":
                        era.addStateEvent("network",ethx,0);
                        break;
                }
            } catch (err) {
                log.error(`failed to check network state of ${ethx}, ${err}`)
            }
        }
    }

    async pingGateway() {
        const gw = sysManager.myDefaultGateway();
        try {
            log.info(`try to ping ${gw}`);
            const {stdout, stderr} = await exec(`ping -w 3 ${gw}`);
            log.info("stdout:", stdout);
            log.info("stderr:", stderr);
            era.addStateEvent("ping",gw,1);
        } catch (err) {
            log.error(`failed to ping ${gw}, ${err}`)
            era.addStateEvent("ping",gw,0);
        }

    }

}

module.exports = EventSensor;