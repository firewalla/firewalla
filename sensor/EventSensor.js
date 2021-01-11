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

const era = require('../event/EventRequestApi.js');
const erh = require('../event/EventRequestHandler');
const ea = require('../event/EventApi.js');
const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');
const COLLECTOR_DIR = f.getFirewallaHome()+"/scripts/event_collectors";
const FEATURE_EVENT = "event_collect";

class EventSensor extends Sensor {

    constructor() {
        super();
        this.scheduledJobs = {};
    }

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
        log.info("Run EventSensor")
        if ( fc.isFeatureOn(FEATURE_EVENT) ) {
            this.startCollectEvents();
        } else {
            this.stopCollectEvents();
        }
        fc.onFeature(FEATURE_EVENT, (feature, status) =>{
            if (feature != FEATURE_EVENT) return
            if (status) {
                this.startCollectEvents();
            } else {
                this.stopCollectEvents();
            }
        })
    }

    async startCollectEvents() {
        try {
            log.info(`Scheduling cleanOldEvents to run every ${this.cleanInterval} seconds`);
            this.cleanJob = setInterval( async () => {
                await this.cleanOldEvents(1000*this.config.expirePeriod);
            }, 1000*this.config.cleanInterval);
            await this.scheduleScriptCollectors();
        } catch (err) {
            log.error("failed to start collect events:", err);
        }
    }

    async stopCollectEvents() {
        try {
            log.info("Stop collecting events");
            if (this.cleanJob) clearInterval(this.cleanJob);
            for (const collector in this.scheduledJobs) {
                clearInterval(scheduledJobs[collector]);
            }
        } catch (err) {
            log.error("failed to start collect events:", err);
        }
    }

    scheduleScriptCollector(collector) {
        let scheduledJob = null;
        try {
            log.info(`Scheduling ${collector}...`);
            const collectorInterval = (collector in this.config.collectorIntervals) ? this.config.collectorIntervals[collector] : this.config.collectorIntervals.default;
            log.info(`every ${collectorInterval} seconds`);
            scheduledJob = setInterval(async () => {
                await this.collectEvent(collector);
            }, 1000*collectorInterval);
        } catch (err) {
            log.error(`failed to schedule ${collector}:`, err);
        }
        return scheduledJob;
    }

    async scheduleScriptCollectors() {
        log.info("Scheduling all script collectors in ", COLLECTOR_DIR);
        try {
            const collectors = await fs.readdirAsync(COLLECTOR_DIR);
            for (const collector of collectors) {
                const scheduledJob = this.scheduleScriptCollector(collector);
                if (scheduledJob) this.scheduledJobs[collector] = scheduledJob;
            }
        } catch (err) {
            log.error(`failed to schedule collectors under ${COLLECTOR_DIR}, ${err}`);
        }
    }

    async cleanOldEvents(cleanBefore) {
        try {
            log.info(`clean events before ${cleanBefore} miliseconds`);
            era.cleanEvents(0, Date.now()-cleanBefore );
        } catch (err) {
            log.error(`failed to clean events before ${cleanBefore}, ${err}`);
        }
    }

    /*
     * Supported collector output:
     * 1) JSON output
     *   STATE:
     *     { "event_type"  : "state",
     *       "state_type"  : <state_type>,
     *       "state_key"   : <state_key>,
     *       "state_value" : <state_value>,
     *       "labels"      : {...}
     *     }
     *   ACTION:
     *     { "event_type"  : "state",
     *       "action_type"  : <action_type>,
     *       "action_value" : <action_value>,
     *       "labels"      : {...}
     *     }
     * 2) Simple output
     *   STATE:
     *     state <state_type> <state_key> <state_value> [<label1>=<label1_value> [<label2>=<label2_value> ...]]
     *   ACTION:
     *     action <action_type> <state_value> [<label1>=<label1_value> [<label2>=<label2_value> ...]]
     */
    async collectEvent(collector) {
        try{
            log.info(`Collect event with ${collector}`);
            // get collector output
            const result = await exec(`${COLLECTOR_DIR}/${collector}`);

            // try to parse as JSON if possible
            let result_obj = null
            try {
                result_obj = JSON.parse(result.stdout);
                this.processJSONOutput(result_obj);
            } catch (err) {
                if (result_obj === null) {
                    this.processSimpleOutput(result.stdout);
                }
            }
        } catch (err) {
            log.error(`failed to collect event with ${collector},${err}`);
        }
    }

    processJSONOutput(result_obj) {
        switch (result_obj.event_type) {
            case 'state':
                era.addStateEvent(result_obj.state_type,result_obj.state_key,parseFloat(result_obj.state_value),result_obj.labels);
                break;
            case 'action':
                era.addActionEvent(result_obj.action_type,parseFloat(result_obj.action_value),result_obj.labels);
                break;
        }

    }

    processSimpleOutput(output) {
        // trigger events API with parameters line by line
        output.split("\n").forEach( (line) => {
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
