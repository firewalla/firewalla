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

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const eventApi = require('./EventApi.js');
const EventQueue = require('../event/EventQueue.js');
const sem = require('../sensor/SensorEventManager.js').getInstance();
const Message = require('../net2/Message.js');

const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();

const KEY_EVENT_REQUEST_STATE = "event:request:state";
const KEY_EVENT_REQUEST_ACTION = "event:request:action";
const KEY_EVENT_REQUEST_CLEAN = "event:request:clean";
const STATE_REQUIRED_FIELDS = [ "ts", "state_type", "state_key", "state_value"];
const ACTION_REQUIRED_FIELDS = [ "ts", "action_type", "action_value"];
const DEFAULT_OK_VALUE = 0;
const STATE_OK_VALUE='ok_value';
const STATE_ERROR_VALUE='error_value';
const STATE_NO_ERROR='no_error';

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


const eventQueueRecycleInterval = 3600000; // 60 minutes
class EventRequestHandler {
    constructor() {
        this.setupRedisSubscriber();
        this.queueMap = new Map();

        setInterval(() => {
            this.cleanupEventQueue();
        }, eventQueueRecycleInterval) // recycle every 60m
    }

    async setupRedisSubscriber() {
        log.info("setup EventHandler");

        sclient.on("message", async (channel, message) => {
            log.debug(`got message in ${channel} - ${message}`);
            switch (channel) {
                case KEY_EVENT_REQUEST_STATE:
                    await this.queueStateEvent(message);
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

    async cleanupEventQueue() {
        log.debug(`event queue map size before cleanup: ${this.queueMap.size}`);
        const deleted = [];
        for (const key of this.queueMap.keys()) {
            const queue = this.queueMap.get(key);
            if (queue && queue.state == 'closed') { // if connection is closed
                log.info(`cleanup closed event queue ${key} (${queue.name})`);
                this.queueMap.delete(key);
                deleted.push(key);
            } else if (queue) {
                log.debug(`checked event queue ${key} (${queue.name}), state ${queue.state}, ts ${queue.lastJobTs}`);
            }
        }
        log.info(`event queue map size after cleanup: ${this.queueMap.size}, ${deleted.length} queues deleted, ${deleted.join(', ')}`);
        log.info(`event queue map items: ${Array.from(this.queueMap.values()).map(q => `${q.name} (${q.state}/${q.getState()} [${q.lastJobTs}])`).join(', ')}`);
    }

    async ensureEventQueue(requestKey) {
        const lockkey = `LOCK_EVENT_QUEUE:${requestKey}`;
        await lock.acquire(lockkey, async () => {
            if (!this.queueMap.has(requestKey) ) {
                log.info(`create event queue for ${requestKey}`);
                const queue = new EventQueue(requestKey);
                await queue.setupEventQueue(1, this.processStateEvent.bind(this));
                this.queueMap.set(requestKey, queue);
            }
            const queue = this.queueMap.get(requestKey);
            if (queue.getState() !== 'ready') {
                log.info(`event queue ${requestKey} is not ready, state ${queue.state}, recreate the queue`);
                if (queue.queue) {
                    try {
                        await queue.queue.close(3000);
                    } catch (err) {
                        log.error(`event queue ${requestKey} failed to close before re-setup, ${err.message}`);
                    } finally {
                        queue.queue = null;
                    }
                }
                await queue.setupEventQueue(1, this.processStateEvent.bind(this));
            }
        });
    }

    isApStateEvent(eventRequest) {
        // check if eventRequest is an AP state event
        return (eventRequest.state_type && eventRequest.state_type.startsWith("ap_"));
    }

    async queueStateEvent(message) {
        log.debug("got state event: ", message);
        try {
            const eventRequest = JSON.parse(message);
            for (const field of STATE_REQUIRED_FIELDS) {
                if ( !(field in eventRequest) ) {
                    throw new Error(`missing required field ${field} in event request`);
                }
            }

            // if not AP state event, process directly in processStateEvent
            if (!this.isApStateEvent(eventRequest)) {
                log.debug(`process non-ap state event directly: ${JSON.stringify(eventRequest)}`);
                return await this.processStateEvent(eventRequest);
            }

            const requestKey = `${eventRequest.state_type}:${eventRequest.state_key}`;
            await this.ensureEventQueue(requestKey);
            const queue = this.queueMap.get(requestKey);
            if (queue) {
                await queue.addEvent(eventRequest);
            } else {
                log.error(`failed to add to event queue ${requestKey}`);
            }
        } catch (err) {
            log.error(`failed to process state event ${message}:`, err.message);
        }
    }

    sendEvent(eventRequest,event_type) {
        log.info(`sending eventRequest ${JSON.stringify(eventRequest)}`);
        try {
            eventApi.addEvent(Object.assign({}, eventRequest,{"event_type":event_type}),eventRequest.ts);
        } catch (err) {
            log.error(`failed to add ${event_type} event(${JSON.stringify(eventRequest)}):`,err);
        }
        // fan out to in-process consumers, e.g. EventSummarySensor. This is the only chokepoint all
        // state events pass through, note controllers/netbot.js adds firewalla_upgrade directly via
        // EventApi and thus bypasses this - that runs in FireApi, where the consumers don't exist.
        try {
            sem.emitLocalEvent({
                type: Message.MSG_EVENT_GENERATED,
                suppressEventLogging: true,
                // labels is copied as well, isStateEventError() mutates it in place (injects
                // ok_value) and consumers may read it asynchronously
                event: Object.assign({}, eventRequest, {
                    "event_type": event_type,
                    "labels": Object.assign({}, eventRequest.labels)
                })
            });
        } catch (err) {
            log.error(`failed to emit ${Message.MSG_EVENT_GENERATED} for ${event_type} event:`,err);
        }
    }

    isNumber(x) {
        return ( typeof x === 'number' && ! isNaN(x));
    }

    /*
     * A "no_error" event ONLY tracks state changes, none of its values is an error,
     * e.g. a mode/selection change that has no faulty value.
     * Unlike other state events, its initial state is sent as an event as well.
     */
    isNoErrorStateEvent(eventRequest) {
        return Boolean(eventRequest.labels && eventRequest.labels[STATE_NO_ERROR]);
    }

    /*
     * Either one of following attributes in "labels" can be provided, an event is considered as an error if
     * - ok_value    : state_value != labels.ok_value
     * - error_value : state_value == labels.error_value
     * If none of above defined, {"ok_value": 0} will be added to "labels" as default.
     * Unless "no_error" is set in "labels", in which case the event is NEVER an error.
     */
    isStateEventError(eventRequest) {
        // state-change-only event, no value of it is recognized as an error
        if (this.isNoErrorStateEvent(eventRequest)) {
            return false;
        }

        if ('labels' in eventRequest) {
            if ( !(STATE_OK_VALUE in eventRequest.labels) && !(STATE_ERROR_VALUE in eventRequest.labels) ) {
                eventRequest.labels.ok_value = 0
            }
        } else {
            eventRequest.labels = { "ok_value":0};
        }

        if ( (STATE_ERROR_VALUE in eventRequest.labels && eventRequest.state_value === eventRequest.labels.error_value)
          || (STATE_OK_VALUE in eventRequest.labels && eventRequest.state_value !== eventRequest.labels.ok_value) ) {
            return true;
        }
        return false;
    }

    async processStateEvent(eventRequest) {
        try{
            log.debug("process state event: ", JSON.stringify(eventRequest));
            const savedEvent = await eventApi.getSavedStateEvent(eventRequest);
            const savedValue = (savedEvent && 'state_value' in savedEvent) ? savedEvent.state_value : null;
            const newValue = eventRequest.state_value;
            if ( !this.isNumber(newValue)) {
                throw new Error(`state_value(${newValue}) of event request is NOT a number`);
            }

            const isError = this.isStateEventError(eventRequest);
            // determine ts0 in event, and send event only if state value changed from last
            if ( savedValue !== null ) {
                if (parseFloat(savedValue) === parseFloat(newValue)) {
                    // state NO change, pass on ts0
                    eventRequest.ts0 = ("ts0" in savedEvent) ? savedEvent.ts0 : savedEvent.ts;
                    eventRequest.prev_state_value = savedEvent.prev_state_value;
                    log.debug(`ignore repeated state ${newValue}`);
                } else {
                    // state changed, reset ts0
                    eventRequest.ts0 = eventRequest.ts;
                    eventRequest.prev_state_value = savedValue;
                    log.debug(`update state value from ${savedValue} to ${newValue}`);
                    this.sendEvent(eventRequest,"state");
                }
            } else {
                // no saved state, record ts0 and ONLY send event if it is ERROR,
                // or if it is a no_error event, whose initial state is a state change on its own
                eventRequest.ts0 = eventRequest.ts;
                if (isError) {
                    log.debug("send initial error state event:",eventRequest);
                    this.sendEvent(eventRequest,"state");
                } else if (this.isNoErrorStateEvent(eventRequest)) {
                    log.debug(`send initial no_error state event ${newValue}:`,eventRequest);
                    this.sendEvent(eventRequest,"state");
                } else {
                    log.debug(`ignore initial state ${newValue}`);
                }
            }
            // update state event request to keep it latest
            await eventApi.saveStateEventRequest(eventRequest);
            // update error state event request to keep it latest
            if (isError) {
                await eventApi.saveStateEventRequestError(eventRequest);
            }
        } catch (err) {
            log.error(`failed to process state event ${JSON.stringify(eventRequest)}:`, err.message);
        } finally {
            log.debug("finished state event: ", JSON.stringify(eventRequest));
        }
    }

    async processActionEvent(message) {
        log.info("got action event: ", message);
        try{
            const eventRequest = JSON.parse(message);
            for (const field of ACTION_REQUIRED_FIELDS) {
                if ( !(field in eventRequest) ) {
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
            if ( 'count' in eventRequest ) {
                await eventApi.cleanEventsByCount(eventRequest.count);
            } else {
                await eventApi.cleanEventsByTime(eventRequest.begin,eventRequest.end);
            }
        } catch (err) {
            log.error(`failed to process clean event ${message}, ${err}`);
        }
    }

}

module.exports = new EventRequestHandler();