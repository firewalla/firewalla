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

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

let erh = null;
let era = null;
let ea = require('../event/EventApi.js');
const f = require('../net2/Firewalla.js');
const COLLECTOR_DIR = f.getFirewallaHome()+"/scripts/event_collectors";

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
                setInterval(() => { this.scheduledJob(); }, 1000 * 60 * 60 ); // run every hour
            },
            1000 * 60 * 5
        ); // first time in 5 minutes
    }

    async scheduledJob() {
        try {
            log.info("Start monitoring and generate events if needed")
            await this.processCollectorOutputs();
            await this.pingGateway();
            log.info("scheduledJob is executed successfully");
        } catch(err) {
            log.error("Failed to run scheduled job, err:", err);
        }
    }

    async processCollectorOutputs() {
        try {
            const collectors = await fs.readdirAsync(COLLECTOR_DIR);
            for (const collector of collectors) {
                this.processCollectorOutput(`${COLLECTOR_DIR}/${collector}`);
            }
        } catch (err) {
            log.error(`failed to process collectors under ${COLLECTOR_DIR}, ${err}`);
        }
    }

    /*
     * supported collector output:
     *   state <state_type> <state_key> <state_value> [<label1>=<label1_value> [<label2>=<label2_value> ...]]
     *   action <action_type> <state_value> [<label1>=<label1_value> [<label2>=<label2_value> ...]]
     */
    async processCollectorOutput(collector) {
        try{
            log.info(`Process output of ${collector}`);
            // get collector output
            const result = await exec(collector);
            // trigger events API with parameters line by line
            result.stdout.split("\n").forEach( (line) => {
                log.info("output line:", line);
                let eventLabels = null;
                const words = line.split(/\s+/);
                switch (words[0]) {
                    case 'state':
                        eventLabels = this.getEventLabels(words.slice(4));
                        era.addStateEvent(words[1],words[2],parseFloat(words[3]),eventLabels);
                        break;
                    case 'action':
                        eventLabels = this.getEventLabels(words.slice(3));
                        era.addActionEvent(words[1],parseFloat(words[2]),eventLabels);
                        break;
                }
            })
        } catch (err) {
            log.error(`failed to process collector output of ${collector},${err}`);
        }
    }

    getEventLabels(words) {
        if (words.length === 0) {
            return null;
        }
        return words.reduce(
            (acc,cur) => {
                const kv = cur.split('=');
                acc[kv[0]] = kv[1];
                return acc;
            },
            {}
        );
    }

    async pingGateway() {
        const gw = sysManager.myDefaultGateway();
        try {
            log.info(`try to ping ${gw}`);
            const {stdout, stderr} = await exec(`ping -w 3 ${gw}`);
            log.debug("stdout:", stdout);
            log.debug("stderr:", stderr);
            era.addStateEvent("ping",gw,1);
        } catch (err) {
            log.error(`failed to ping ${gw}, ${err}`)
            era.addStateEvent("ping",gw,0);
        }

    }

}

module.exports = EventSensor;