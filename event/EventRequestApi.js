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

const log = require('../net2/logger.js')(__filename,"debug");

const pclient = require('../util/redis_manager.js').getPublishClient();

const KEY_EVENT_REQUEST_STATE = "event:request:state";
const KEY_EVENT_REQUEST_ACTION = "event:request:action";
const KEY_EVENT_REQUEST_CLEAN = "event:request:clean";

/*
 * EventRequestApi send event requests onto redis channels for processing
 * 
 * Supported APIs:
 * - add event : STATE or ACTION
 * - clean event
 * - list events
 *
 */
class EventRequestApi {
    constructor() {
    }

    isNumber(x) {
        return ( typeof x === 'number' && ! isNaN(x));
    }

    async addStateEvent(state_type,state_key,state_value,labels=null, ts=Date.now()) {
        log.debug("add state event");

        try {
            let event_obj = {
                "ts": ts,
                "event_type": "state",
                "state_type": state_type,
                "state_key": state_key,
                "state_value": state_value
            }

            if ( labels !== null ) {
                event_obj["labels"] = labels;
            }

            if ( ! this.isNumber(state_value) ) {
                throw new Error(`state_value(${state_value}) is NOT a number`);
            }
            const event_json = JSON.stringify(event_obj);
            log.debug("event_json:",event_json);
            await pclient.publishAsync(KEY_EVENT_REQUEST_STATE,event_json);
        } catch (err) {
            log.error(`failed to publish state event(${state_type} ${state_key} ${state_value}): ${err}`);
        }
    }

    async addActionEvent(action_type,action_value,labels=null, ts=Date.now()) {
        log.debug("add action event");

        try {
            let event_obj = {
                "ts": ts,
                "event_type": "action",
                "action_type": action_type,
                "action_value": action_value
            }
            if ( labels !== null ) {
                event_obj["labels"] = labels;
            }

            if ( ! this.isNumber(action_value) ) {
                throw new Error(`action_value(${action_value}) is NOT a number`);
            }
            const event_json = JSON.stringify(event_obj);
            await pclient.publishAsync(KEY_EVENT_REQUEST_ACTION,event_json);
        } catch (err) {
            log.error(`failed to publish action event(${action_type} ${action_value}): ${err}`);
        }
    }

    async cleanEventsByTime(begin=0, end=0) {
        log.info(`clean events from ${begin} to ${end}`);

        try {
            const clean_obj = {
                "begin": begin,
                "end" : end
            }
            if ( ! this.isNumber(begin) || ! this.isNumber(end)) {
                throw new Error(`begin(${begin}) or end(${end}) is NOT number`);
            }
            const clean_json = JSON.stringify(clean_obj);
            await pclient.publishAsync(KEY_EVENT_REQUEST_CLEAN,clean_json);
        } catch (err) {
            log.error(`failed to clean events from ${begin} to ${end}: ${err}`);
        }
    }

    async cleanEventsByCount(count=1) {
        log.info(`clean oldest ${count} events`);

        try {
            const clean_obj = { "count": count }
            const clean_json = JSON.stringify(clean_obj);
            await pclient.publishAsync(KEY_EVENT_REQUEST_CLEAN,clean_json);
        } catch (err) {
            log.error(`failed to clean oldest ${count} events: ${err}`);
        }
    }
}

/*
( async () => {
    let x = new EventRequestApi();
    console.log(await x.listEvents(0,Date.now()));
})();
*/

module.exports = new EventRequestApi();
