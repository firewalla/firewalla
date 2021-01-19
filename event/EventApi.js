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

    async listEvents(begin="-inf", end="inf", limit_offset=0, limit_count=-1) {
      let result = null
      try {
        log.info(`getting events from ${begin} to ${end}`);
        result = await rclient.zrangebyscoreAsync([KEY_EVENT_LOG, begin, end, "withscores","limit",limit_offset,limit_count]);
      } catch (err) {
        log.error(`failed to get events between ${begin} and ${end}, with limit offset(${limit_offset}) and count(${limit_count}), ${err}`);
        result = null;
      }
      return result;
    }

    async addEvent(event_obj, ts=Math.round(Date.now())) {
      // inject ts in "event_json" to make event unique in case of duplicate actions
      let redis_obj = ("ts" in event_obj) ? event_obj : Object.assign({},event_obj,{"ts":ts});
      let redis_json = JSON.stringify(redis_obj);
      try {
        log.info(`adding event ${redis_json} at ${ts}`);
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
        await rclient.zpopminAsync(KEY_EVENT_LOG,count);
      } catch (err) {
        log.error(`failed to delete oldest ${count} events: ${err}`);
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
