/*    Copyright 2020-2021 Firewalla Inc.
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
const extensionManager = require('./ExtensionManager.js')
const sysManager = require('../net2/SysManager.js');

const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);

const f = require('../net2/Firewalla.js');
const fc = require('../net2/config.js');
const platform = require('../platform/PlatformLoader.js').getPlatform();
const COLLECTOR_DIR = f.getFirewallaHome()+"/scripts/event_collectors";
const FEATURE_EVENT = "event_collect";
const era = require('../event/EventRequestApi.js');
const ea = require('../event/EventApi.js');
const um = require('../net2/UpgradeManager.js');

class EventSensor extends Sensor {

    constructor(config) {
        super(config);
        this.scheduledJobs = {};
    }

    async apiRun() {

        if ( ! platform.isEventsSupported() ) {
            log.warn(`${FEATURE_EVENT} NOT supported on this platform`);
            return;
        }

        extensionManager.onGet("events", async (msg, data) => {
            try {
                log.info(`processing onGet events with data(${JSON.stringify(data)})`);
                let result = await ea.listEvents(data.min, data.max, data.limit_offset, data.limit_count, data.reverse, data.parse_json, data.filters);
                return result;
            } catch (err) {
                log.error(`failed to list events with ${JSON.stringify(data)}, ${err}`);
            }
        });

        extensionManager.onGet("latestAllStateEvents", async (msg, data) => {
            try {
                log.info(`processing onGet latest events with data(${JSON.stringify(data)})`);
                let result = await ea.listLatestStateEventsAll(data.parse_json);
                return result;
            } catch (err) {
                log.error(`failed to list latest all events with ${JSON.stringify(data)}, ${err}`);
            }
        });

        extensionManager.onGet("latestErrorStateEvents", async (msg, data) => {
            try {
                log.info(`processing onGet latest error events with data(${JSON.stringify(data)})`);
                let result = await ea.listLatestStateEventsError(data.parse_json);
                return result;
            } catch (err) {
                log.error(`failed to list latest error events with ${JSON.stringify(data)}, ${err}`);
            }
        });
    }

    async run() {
        if ( ! platform.isEventsSupported() ) {
            log.warn(`${FEATURE_EVENT} NOT supported on this platform`);
            return;
        }

        /*
         * IMPORTANT
         * Only initialize EventRequestHandler in run() for FireMain
         * If done in class level, it will cause a duplicate handler of redis channel
         */
        const erh = require('../event/EventRequestHandler');
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

    getConfiguredInterval(name) {
        return (name in this.config.intervals) ?
            this.config.intervals[name] : this.config.intervals.default;
    }


    async startCollectEvents() {
        try {
            log.info("start collect events...");
            this.scheduledJSJobs();
            await this.scheduleScriptCollectors();
            // schedule cleanup latest state data
            this.scheduledJobs["cleanLatestStateEventsByTime"] = setInterval(async () => {
                await this.cleanLatestStateEventsByTime(this.config.latestStateEventsExpire);
            }, 1000*this.config.intervals.cleanEventsByTime);
        } catch (err) {
            log.error("failed to start collect events:", err);
        }
    }

    async stopCollectEvents() {
        try {
            log.info("Stop collecting events...");
            for (const job in this.scheduledJobs) {
                log.info(`Stop collecting ${job}`);
                clearInterval(this.scheduledJobs[job]);
            }
        } catch (err) {
            log.error("failed to start collect events:", err);
        }
    }

    scheduledJSJobs() {
        const JS_JOBS = ['cleanEventsByTime', 'cleanEventsByCount'];
        for (const jsjob of JS_JOBS) {
            log.info(`Scheduling ${jsjob} every ${this.getConfiguredInterval(jsjob)} seconds`);
            this.scheduledJobs[jsjob] = setInterval( async() => {
                await this[jsjob]();
            }, 1000*this.getConfiguredInterval(jsjob));
        }
    }

    scheduleScriptCollector(collector) {
        let scheduledJob = null;
        try {
            const collectorInterval = this.getConfiguredInterval(collector);
            if ( collectorInterval < 1) {
                log.warn(`${collector} is NOT scheduled with interval of ${collectorInterval}`);
            } else {
                log.info(`Scheduling ${collector} every ${collectorInterval} seconds`);
                scheduledJob = setInterval(async () => {
                    await this.collectEvent(collector);
                }, 1000*collectorInterval);
            }
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
            log.error(`failed to schedule collectors under ${COLLECTOR_DIR}: ${err}`);
        }
    }

    async cleanLatestStateEventsByTime(expirePeriod) {
        try {
            log.info(`clean latest state events older than ${expirePeriod} seconds`);
            await ea.cleanLatestStateEventsByTime(Date.now()-1000*expirePeriod);
        } catch (err) {
            log.error(`failed to clean latest state events older than ${expirePeriod} seconds: ${err}`);
        }
    }

    async cleanEventsByTime() {
        try {
            log.info(`clean events before ${this.config.eventsExpire} seconds`);
            await era.cleanEventsByTime(0, Date.now()-1000*this.config.eventsExpire );
        } catch (err) {
            log.error(`failed to clean events before ${this.config.eventsExpire} seconds: ${err}`);
        }
    }

    async cleanEventsByCount() {
        try {
            log.info("Start cleaning events by count...");
            const currentCount = await ea.getEventsCount();
            log.info("currentCount:", currentCount);
            const cleanCount = currentCount - this.config.eventsLimit;
            if ( cleanCount > 0 ) {
                log.info(`clean oldest ${cleanCount} events`);
                await era.cleanEventsByCount(cleanCount);
            } else {
                log.debug(`current_events_count(${currentCount}) <= clean_limit(${this.config.eventsLimit}), NO need to clean`)
            }
        } catch (err) {
            log.error(`failed to clean events over count of ${this.config.eventsLimit}: ${err}`);
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
     *     { "event_type"  : "action",
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
            log.debug("output line:", line);
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
        log.info(`try to ping gateways...`);
        const PACKET_COUNT = 8;
        const stateType = "ping";
        const labels = {"packet_count": PACKET_COUNT};
        for (const gw of sysManager.myGateways() ) {
            try {
                log.debug(`ping ${gw}`);
                const result = await exec(`ping -n -c ${PACKET_COUNT} -W 3 ${gw}`);
                for (const line of result.stdout.split("\n")) {
                    const found = line.match(/ ([0-9]+)% packet loss/);
                    if (found) {
                        labels.loss_rate = found[1];
                        break
                    }
                }
                era.addStateEvent(stateType,gw,0,labels);
            } catch (err) {
                log.error(`failed to ping ${gw}: ${err}`);
                era.addStateEvent(stateType,gw,1,labels);
            }
        }
    }

    async digDNS() {
        log.info(`try to dig DNS...`);
        const stateType = "dns";
        for (const dns of sysManager.myDnses() ) {
            try {
                await exec(`dig @${dns} google.com +short`);
                era.addStateEvent(stateType,dns,0);
            } catch (err) {
                log.error(`failed to dig ${dns}: ${err}`);
                era.addStateEvent(stateType,dns,1);
            }
        }
    }

}

module.exports = EventSensor;
