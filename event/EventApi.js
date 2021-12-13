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

const log = require('../net2/logger.js')(__filename);

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

const KEY_EVENT_LOG = "event:log";
const KEY_EVENT_STATE_CACHE = "event:state:cache";
const KEY_EVENT_STATE_CACHE_ERROR = "event:state:cache:error";

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
        let result = {};
        try {
            result = await rclient.hgetallAsync(KEY_EVENT_STATE_CACHE);
            if (result && parse_json) {
                Object.keys(result).forEach( (k)=>{result[k] = JSON.parse(result[k]) });
            }
        } catch (err) {
            log.error("failed to get all saved state event requests:",err);
            result = {};
        }
        return result;
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
        let result = {};
        try {
            result = await rclient.hgetallAsync(KEY_EVENT_STATE_CACHE_ERROR);
            if (result && parse_json) {
                Object.keys(result).forEach( (k)=>{result[k] = JSON.parse(result[k]) });
            }
        } catch (err) {
            log.error("failed to get all error state event requests:",err);
            result = {};
        }
        return result;
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

    async addEvent(event_obj, ts=Math.round(Date.now())) {
      // inject ts in "event_json" to make event unique in case of duplicate actions
      let redis_obj = ("ts" in event_obj) ? event_obj : Object.assign({},event_obj,{"ts":ts});
      let redis_json = JSON.stringify(redis_obj);
      try {
        log.debug(`adding event ${redis_json} at ${ts}`);
        log.debug(`KEY_EVENT_LOG=${KEY_EVENT_LOG}`);
        log.debug(`ts=${ts}`);
        log.debug(`redis_json=${redis_json}`);
        await rclient.zaddAsync([KEY_EVENT_LOG,ts,redis_json]);
      } catch (err) {
        log.error(`failed to add event ${redis_json} at ${ts}: ${err}`);
      }
    }

    async getEventsCount(begin="-inf", end="inf") {
      let result = null;
      try {
        log.info(`get events count from ${begin} to ${end}`);
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
