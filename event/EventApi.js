/*    Copyright 2020-2026 Firewalla Inc.
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

const rclient = require('../util/redis_manager.js').getRedisClient()
const eventClassifier = require('./EventClassifier.js');
const AsyncLock = require('../vendor_lib/async-lock');
// vendored default of 1000 pending is too low for a burst on one classifier key
const lock = new AsyncLock({ maxPending: 10000 });

const KEY_EVENT_LOG = "event:log";
const KEY_EVENT_STATE_CACHE = "event:state:cache";
const KEY_EVENT_STATE_CACHE_ERROR = "event:state:cache:error";
// hash of the latest event of each classified type, field = EventClassifier.classify(event)
const KEY_EVENT_LAST_CACHE = "event:last:cache";

const STATE_CACHE_MAX_KEYS_RETURN = 100;
// cap on distinct types tracked in KEY_EVENT_LAST_CACHE, to bound its size. Entries also expire
// via cleanLatestStateEventsByTime(), but that is scheduled inside EventSensor.startCollectEvents()
// and therefore gated on the event_collect feature, while events are written regardless - so this
// cap, not the expiry, is the real backstop
const MAX_LAST_CACHE_KEYS = 5000;
// cap on how many entries listLastEventsBefore() returns, to bound the init payload. The hash can
// hold up to MAX_LAST_CACHE_KEYS entries and each value is a whole event, so returning it all would
// add megabytes to init. Entries are returned newest-first, so the cap drops the stalest types
const LAST_CACHE_MAX_KEYS_RETURN = 200;

/*
 * EventApi provides API to event data access in Redis
 * 
 * Events are saved in Redis as sorted set
 * event:log => [
 *   { <timestamp_as_score>, "<event_json>" }
 * ]
 * 
 * NOTE: Value of timestamp is also injected into "event_json" so as to make event unique in case of duplicate actions
 */
class EventApi {
    constructor() {
    }

    async getSavedStateEvent(eventRequest) {
        const stateEventKey = eventRequest.state_type+":"+eventRequest.state_key;
        let savedEvent = null;
        try {
            const savedRequestJson = await rclient.hgetAsync(KEY_EVENT_STATE_CACHE, stateEventKey);
            log.debug(`got ${savedRequestJson} for ${stateEventKey} in ${KEY_EVENT_STATE_CACHE} from Redis`);
            if (savedRequestJson) {
                savedEvent = JSON.parse(savedRequestJson);
            }
        } catch (err) {
            log.error(`failed to get saved value of ${stateEventKey} in ${KEY_EVENT_STATE_CACHE} from Redis:`, err);
        }
        return savedEvent;
    }

    async saveStateEventRequest(eventRequest) {
        const stateEventKey = eventRequest.state_type+":"+eventRequest.state_key;
        try {
            const er_json = JSON.stringify(eventRequest);
            log.debug(`save state event request(${er_json}) at ${stateEventKey} in ${KEY_EVENT_STATE_CACHE}`);
            await rclient.hsetAsync(KEY_EVENT_STATE_CACHE,stateEventKey,er_json);
        } catch (err) {
            log.error(`failed to save event request for ${stateEventKey} in ${KEY_EVENT_STATE_CACHE}:`,err);
        }
    }

    async listLatestStateEventsAll(parse_json=true) {
        try {
            const result = await rclient.hgetallAsync(KEY_EVENT_STATE_CACHE);
            if (result && parse_json) {
                Object.keys(result).forEach( (k)=>{result[k] = JSON.parse(result[k]) });
                const keys = Object.keys(result);
                keys.sort( (a,b) => result[b].ts - result[a].ts )
                return keys.slice(0, STATE_CACHE_MAX_KEYS_RETURN)
                  .reduce((acc, k) => { acc[k] = result[k]; return acc; }, {});
            }
        } catch (err) {
            log.error("failed to get all saved state event requests:",err);
        }
        return {}
    }

    async saveStateEventRequestError(eventRequest) {
        const stateEventRequestKey = eventRequest.state_type+":"+eventRequest.state_key;
        try {
            const er_json = JSON.stringify(eventRequest);
            log.debug(`save state event request(${er_json}) at ${stateEventRequestKey} in ${KEY_EVENT_STATE_CACHE_ERROR}`);
            await rclient.hsetAsync(KEY_EVENT_STATE_CACHE_ERROR,stateEventRequestKey,er_json);
        } catch (err) {
            log.error(`failed to save event request for ${stateEventRequestKey} in ${KEY_EVENT_STATE_CACHE_ERROR}:`,err);
        }
    }

    async listLatestStateEventsError(parse_json=true) {
        try {
            const result = await rclient.hgetallAsync(KEY_EVENT_STATE_CACHE_ERROR);
            if (result && parse_json) {
                Object.keys(result).forEach( (k)=>{result[k] = JSON.parse(result[k]) });
                const keys = Object.keys(result);
                keys.sort( (a,b) => result[b].ts - result[a].ts )
                return keys.slice(0, STATE_CACHE_MAX_KEYS_RETURN)
                  .reduce((acc, k) => { acc[k] = result[k]; return acc; }, {});
            }
        } catch (err) {
            log.error("failed to get all error state event requests:",err);
        }
        return {}
    }

    async getLatestEventsByType(type, offset = 600000, limit_count = 10) {
        let now = Date.now();
        try {
            let data = await rclient.zrevrangebyscoreAsync(KEY_EVENT_LOG, now, now-offset);
            data = limit_count > 0 ? data.slice(0, limit_count) : data;
            let events = data.map( i => JSON.parse(i)).filter( i => i.event_type == "action" ? i.action_type == type : i.state_type == type);
            return events;
        } catch(e) {
            log.warn("Failed to get event by type", type, e);
        }
        return [];
    }

    async getEventByTs(ts) {
        try {
            const result = await rclient.zrangebyscoreAsync(KEY_EVENT_LOG, ts, ts);
            return JSON.parse(result);
        } catch {
            log.warn("Failed to get event by timestamp", ts);
        }
        return {}
    }

    async listEvents(min="-inf", max="inf", limit_offset=0, limit_count=-1, reverse=false, parse_json=true, filters = null) {
      let results = [];
      try {
        log.info(`getting events from ${min} to ${max}`);
        const [begin,end] = reverse ? [max,min] : [min,max];
        const params = [KEY_EVENT_LOG, begin, end];

        results = reverse ? await rclient.zrevrangebyscoreAsync(params) : await rclient.zrangebyscoreAsync(params);
        if (results && parse_json) {
          results.forEach((x,idx)=>results[idx]=JSON.parse(x));
          if (filters) {
            results = results.filter(e => filters.some(f => {
              if (f.event_type) {
                if (e.event_type !== f.event_type) // "event_type" can be either "state" or "action"
                  return false;
                if (f.sub_type && e[f.event_type + "_type"] !== f.sub_type) // key is either "state_type" or "action_type"
                  return false;
              }
              return true;
            }));
          }
        }
        results = limit_count > 0 ? results.slice(limit_offset, limit_offset + limit_count) : results.slice(limit_offset);
      } catch (err) {
        log.error(`failed to get events between ${min} and ${max}, with limit offset(${limit_offset})/count(${limit_count}) and reverse(${reverse}), ${err}`);
        results = [];
      }
      return results;
    }

    /*
     * Stamps event_obj.last_ts from KEY_EVENT_LAST_CACHE and refreshes that cache.
     *
     * last_ts is the ts of the most recent previously recorded event that classified to the same
     * type, or null when there is none - and also null when the only candidate is NEWER than this
     * event, i.e. this event arrived out of order. Emission order is NOT ts order - ap_ and
     * switch_ state events go through a bee-queue while the rest are processed inline - and a
     * last_ts in the future would show up as a previous occurrence that has not happened yet.
     *
     * Mutates the (already copied) redis_obj in place. Callers must not let this reject.
     */
    async stampLastTs(redis_obj) {
      const hashKey = eventClassifier.classify(redis_obj);
      if (!hashKey) return; // no setting matches, this event carries no last_ts at all
      await lock.acquire(hashKey, async () => {
        const prev = await rclient.hgetAsync(KEY_EVENT_LAST_CACHE, hashKey).then(r => r && JSON.parse(r));
        const prevTs = prev ? Number(prev.ts) : NaN;
        const newTs = Number(redis_obj.ts);
        // an explicit null rather than a dropped field, so "first event of this type" stays
        // distinguishable from "field not supported", and so every event of a type serializes
        // its keys in the same order
        redis_obj.last_ts = (Number.isFinite(prevTs) && Number.isFinite(newTs) && prevTs <= newTs) ? prevTs : null;
        // a late-arriving older event must not roll the cache backwards
        if (Number.isFinite(prevTs) && !(newTs >= prevTs)) return;
        // only pay for the HLEN on a miss - the steady state stays one HGET plus one HSET
        if (!prev && await rclient.hlenAsync(KEY_EVENT_LAST_CACHE) >= MAX_LAST_CACHE_KEYS) {
          log.warn(`${KEY_EVENT_LAST_CACHE} reached cap(${MAX_LAST_CACHE_KEYS}), not tracking ${hashKey}`);
          return;
        }
        await rclient.hsetAsync(KEY_EVENT_LAST_CACHE, hashKey, JSON.stringify(redis_obj));
      });
    }

    /*
     * NOTE: this is called WITHOUT await from EventRequestHandler.sendEvent(), so its try/catch
     * cannot catch anything asynchronous - this function must never reject. Everything, including
     * the object construction and JSON.stringify, is inside the try for that reason.
     */
    async addEvent(event_obj, ts=Math.round(Date.now())) {
      let redis_json = null;
      try {
        // inject ts in "event_json" to make event unique in case of duplicate actions. Always a
        // fresh object - last_ts is assigned below and must not leak back into the caller's object
        const redis_obj = ("ts" in event_obj) ? Object.assign({},event_obj) : Object.assign({},event_obj,{"ts":ts});
        // failing to classify must only cost this event its last_ts, never its place in event:log
        await this.stampLastTs(redis_obj).catch( (err) => {
          log.error(`failed to stamp last_ts on event ${JSON.stringify(redis_obj)}:`, err.message);
        });
        redis_json = JSON.stringify(redis_obj);
        log.debug(`adding event ${redis_json} at ${ts}`);
        log.debug(`KEY_EVENT_LOG=${KEY_EVENT_LOG}`);
        log.debug(`ts=${ts}`);
        log.debug(`redis_json=${redis_json}`);
        await rclient.zaddAsync([KEY_EVENT_LOG,ts,redis_json]);
      } catch (err) {
        log.error(`failed to add event ${redis_json} at ${ts}: ${err}`);
      }
    }

    /*
     * The latest event of every classified type whose ts is OLDER than maxTs, newest first.
     *
     * Companion to listEvents() over the recent window: a type whose latest event falls inside that
     * window is already in those results, so this returns only the types the window cannot show -
     * the ones that last happened before it. Each entry is the whole event, last_ts included, so a
     * caller can walk one step further back without another lookup.
     */
    async listLastEventsBefore(maxTs, limit_count = LAST_CACHE_MAX_KEYS_RETURN) {
      try {
        const result = await rclient.hgetallAsync(KEY_EVENT_LAST_CACHE);
        if (!result) return [];
        const events = [];
        for (const field of Object.keys(result)) {
          try {
            const event = JSON.parse(result[field]);
            // a malformed or ts-less entry would sort unpredictably and tell the caller nothing
            if (event && Number.isFinite(Number(event.ts)) && Number(event.ts) < maxTs)
              events.push(event);
          } catch (err) {
            log.error(`failed to parse event at ${field} in ${KEY_EVENT_LAST_CACHE}:`, err.message);
          }
        }
        events.sort((a, b) => b.ts - a.ts);
        return limit_count > 0 ? events.slice(0, limit_count) : events;
      } catch (err) {
        log.error(`failed to list last events before ${maxTs}:`, err.message);
      }
      return [];
    }

    async getEventsCount(begin="-inf", end="inf") {
      let result = null;
      try {
        log.verbose(`get events count from ${begin} to ${end}`);
        const result_str = await rclient.zcountAsync(KEY_EVENT_LOG,begin,end);
        result = parseInt(result_str);
      } catch (err) {
        log.error(`failed to get events count from ${begin} to ${end}: ${err}`);
      }
      return result;
    }

    async cleanEventsByTime(begin="0", end="0") {
      try {
        log.info(`deleting events from ${begin} to ${end}`);
        await rclient.zremrangebyscoreAsync(KEY_EVENT_LOG,begin,end);
      } catch (err) {
        log.error(`failed to delete events between ${begin} and ${end}: ${err}`);
      }
    }

    async cleanEventsByCount(count=1) {
      try {
        log.info(`deleting oldest ${count} events`);
        // ZPOPMIN only available since Redis 5.0.0, use ZREMRANGEBYRANK instead
        //await rclient.zpopminAsync(KEY_EVENT_LOG,count);
        await rclient.zremrangebyrankAsync(KEY_EVENT_LOG,0,count-1);
      } catch (err) {
        log.error(`failed to delete oldest ${count} events: ${err}`);
      }
    }

    async cleanCachedEventsByTime(redisKey, expireTS) {
      try {
        log.info(`deleting events at ${redisKey} earlier than ${expireTS}`);

        let scanCursor = 0;
        while (true) {
          const scanResult = await rclient.hscanAsync(redisKey,scanCursor);
          if ( ! scanResult ) {
            log.error(`hscan on key(${redisKey}) failed at cursor(${scanCursor}) with invalid result`);
            break;
          }
          for (let i=0; i<scanResult[1].length; i+=2) {
            const hkey = scanResult[1][i];
            const json_obj = JSON.parse(scanResult[1][i+1]);
            if ( json_obj && json_obj.ts < expireTS) {
              log.debug(`deleting expired (${json_obj.ts}<${expireTS}) ${hkey} at ${redisKey}`);
              await rclient.hdelAsync(redisKey, hkey);
            }
          }
          scanCursor = parseInt(scanResult[0]);
          if ( scanCursor === 0 ) break;
        }

      } catch (err) {
        log.error(`failed to delete events at ${redisKey} eariler than ${expireTS}: ${err}`);
      }

    }

    async cleanLatestStateEventsByTime(expireTime) {
      try {
        log.info(`deleting latest all events before ${expireTime}`);
        await this.cleanCachedEventsByTime(KEY_EVENT_STATE_CACHE,expireTime);
        log.info(`deleting latest error events before ${expireTime}`);
        await this.cleanCachedEventsByTime(KEY_EVENT_STATE_CACHE_ERROR,expireTime);
        log.info(`deleting latest events per type before ${expireTime}`);
        await this.cleanCachedEventsByTime(KEY_EVENT_LAST_CACHE,expireTime);
      } catch (err) {
        log.error(`failed to delete latest events before ${expireTime}: ${err}`);
      }
    }

}

module.exports = new EventApi();

/* unit test
(async () => {
  try {
    let x = new EventApi();
    console.log( await x.listEvents() );
    // add a new event
    x.addEvent({"key1":Date.now()});
    console.log( await x.listEvents() );
    // del events older than 10 seconds
    x.cleanEvents(0,Math.round(Date.now())-10000);
    console.log( await x.listEvents() );
  } catch (e) {
    console.error(e);
  }
})();
*/
