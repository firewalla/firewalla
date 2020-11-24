
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

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()

let instance = null;
const KEY_EVENT_LOG = "event:log";

class EventApi {
    constructor() {
    }

    async getEvents(begin="-inf", end="inf") {
        let result = await rclient.zrangebyscoreAsync([KEY_EVENT_LOG, begin, end, "withscores"]);
        return result;
    }

    async addEvent(event_json,ts=Math.round(Date.now())) {
        await rclient.zaddAsync(KEY_EVENT_LOG,ts,JSON.stringify(event_json));
    }

    async delEvents(begin="0", end="0") {
        await rclient.zremrangebyscoreAsync(KEY_EVENT_LOG,begin,end);
    }
}

function getInstance() {
  if (!instance) {
    instance = new EventApi();
  }
  return instance;
}

module.exports = {
  getInstance:getInstance
};

/* unit test
*/
(async () => {
  try {
    let x = new EventApi();
    console.log( await x.getEvents() );
    // add a new event
    x.addEvent({"key1":Date.now()});
    console.log( await x.getEvents() );
    // del events older than 10 seconds
    x.delEvents(0,Math.round(Date.now())-10000);
    console.log( await x.getEvents() );
  } catch (e) {
    console.error(e);
  }
})();
