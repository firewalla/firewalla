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

const log = require('../net2/logger.js')(__filename,"debug");

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const eventApi = require('./EventApi.js');

const KEY_EVENT_REQUEST_STATE = "event:request:state";
const KEY_EVENT_REQUEST_ACTION = "event:request:action";
const KEY_EVENT_REQUEST_CLEAN = "event:request:clean";
const KEY_EVENT_STATE_PREFIX = "event:state";
const STATE_REQUIRED_FIELDS = [ "ts", "state_type", "state_key", "state_value"]
const ACTION_REQUIRED_FIELDS = [ "ts", "action_type", "action_value"]

/*
 * EventRequestHandler accepts event requests from redis channels and processes them accordingly
 * 
 * There are 2 types of event requests
 * - STATE  : a state change that ONLY trigger an event if state value different from previous
 *            redis channel = event:request:state
 * - ACTION : an action that will ALWAYS trigger an event
 *            redis channel = event:request:action
 * 
 * Values of STATE events are stored at following keys in Redis
 *     event:state:<state_type>:<state_key>
 */
class EventRequestHandler {
    constructor() {
        this.setupRedisSubscriber();
    }

    async setupRedisSubscriber() {
        log.info("setup EventHandler");

        sclient.on("message", async (channel, message) => {
            log.debug(`got message in ${channel} - ${message}`);
            switch (channel) {
                case KEY_EVENT_REQUEST_STATE:
                    await this.processStateEvent(message);
                    break;
                case KEY_EVENT_REQUEST_ACTION:
                    await this.processActionEvent(message);
                    break;
                case KEY_EVENT_REQUEST_CLEAN:
                    await this.processCleanEvent(message);
                    break;

            }
        });

        sclient.subscribe(KEY_EVENT_REQUEST_STATE);
        sclient.subscribe(KEY_EVENT_REQUEST_ACTION);
        sclient.subscribe(KEY_EVENT_REQUEST_CLEAN);
    }

    async getStateEventSavedValue(eventRequest) {
        const stateEventRequestKey = KEY_EVENT_STATE_PREFIX+":"+eventRequest.state_type+":"+eventRequest.state_key;
        let savedValue = null;
        try {
            savedValue = await rclient.getAsync(stateEventRequestKey)
            log.debug(`got ${savedValue} for ${stateEventRequestKey} from Redis`);
        } catch (err) {
            log.error(`failed to get saved value of ${stateEventRequestKey} in Redis, ${err}`);
        }
        return savedValue;
    }

    sendEvent(eventRequest,event_type) {
        log.info(`sending eventRequest ${JSON.stringify(eventRequest)}`);
        try {
            eventApi.addEvent(Object.assign({}, eventRequest,{"event_type":event_type}),eventRequest.ts);
        } catch (err) {
            log.error(`failed to add event with timestamp ${eventRequest.ts}`);
        }
    }

    saveStateEventValue(eventRequest) {
        log.info(`save state event value ${eventRequest.state_value}`);
        const stateEventRequestKey = KEY_EVENT_STATE_PREFIX+":"+eventRequest.state_type+":"+eventRequest.state_key;
        try {
            rclient.set(stateEventRequestKey,eventRequest.state_value);
        } catch (err) {
            log.error(`failed to save value ${eventRequest.state_value} for ${stateEventRequestKey} in Redis`);
        }
    }

    isNumber(x) {
        return ( typeof x === 'number' && ! isNaN(x));
    }

    async processStateEvent(message) {
        log.info("got state event: ", message);
        try{
            const eventRequest = JSON.parse(message);
            for (const field of STATE_REQUIRED_FIELDS) {
                if ( ! field in eventRequest ) {
                    throw new Error(`missing required field ${field} in event request`);
                }
            }
            const savedValue = await this.getStateEventSavedValue(eventRequest);
            const newValue = eventRequest.state_value
            if ( !this.isNumber(newValue)) {
                throw new Error(`state_value(${newValue}) of event request is NOT a number`);
            }

            if ( savedValue !== null && parseFloat(savedValue) === parseFloat(newValue) ) {
                log.warn(`ignore repeated state ${newValue}`);
            } else {
                log.debug(`update state value from ${savedValue} to ${newValue}`);
                this.sendEvent(eventRequest,"state");
                this.saveStateEventValue(eventRequest);
            }

        } catch (err) {
            log.error(`failed to process state event ${message}, ${err}`);
        }
    }

    async processActionEvent(message) {
        log.info("got action event: ", message);
        try{
            const eventRequest = JSON.parse(message);
            for (const field of ACTION_REQUIRED_FIELDS) {
                if ( ! field in eventRequest ) {
                    throw new Error(`missing required field ${field} in event request`);
                }
            }

            const actionValue = eventRequest.action_value
            if ( !this.isNumber(actionValue)) {
                throw new Error(`action_value(${actionValue}) of event request is NOT a number`);
            }
            log.debug(`update action value to ${actionValue}`);
            this.sendEvent(eventRequest,"action");

        } catch (err) {
            log.error(`failed to process action event ${message}, ${err}`);
        }
    }

    async processCleanEvent(message) {
        log.info("got clean event: ", message);
        try{
            const eventRequest = JSON.parse(message);
            await eventApi.delEvents(eventRequest.begin,eventRequest.end);
        } catch (err) {
            log.error(`failed to process clean event ${message}, ${err}`);
        }
    }

}

module.exports = new EventRequestHandler();