/*    Copyright 2016 Firewalla LLC
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

let log = require('../net2/logger.js')(__filename);

const EventEmitter = require('events');

const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

let instance = null;

class SensorEventManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.subscribeEvent();
  }

  getRemoteChannel(title) {
    return "TO." + title;
  }

  subscribeEvent() {
    sclient.on("message", (channel, message) => {
      if(channel === this.getRemoteChannel(process.title)) {
        log.info(`Got a remote message for channel ${channel}: ${message}`)
        try {
          let m = JSON.parse(message)
          this.emitEvent(m);
        } catch (err) {
          log.error("Failed to parse channel message:", err, {});
        }
      } else {
        log.debug("Ignore channel", channel, {});
      }
    });

    sclient.subscribe(this.getRemoteChannel(process.title));
  }

  clearEventType(eventType) {
    this.removeAllListeners(eventType)
  }
  

  emitEvent(event) {
    if(!event.suppressEventLogging) {
      log.info("New Event: " + event.type + " -- " + (event.message || "(no message)"));
    }

    if(event.toProcess && event.toProcess !== process.title) {
      // this event is meant to send to another process
      let channel = this.getRemoteChannel(event.toProcess);
      pclient.publish(channel, JSON.stringify(event));
      return;
    }

    log.debug(event.type, "subscribers: ", this.listenerCount(event.type), {});
    let count = this.listenerCount(event.type);
    if(count === 0) {
      log.error("No subscription on event type:", event.type, {});
    } else if (count > 1) {
      // most of time, only one subscribe on each event type
      log.warn("Subscribers on event type:", event.type, "is more than ONE", {});
      this.emit(event.type, event);
    } else {
      this.emit(event.type, event);
    }
  }

  on(event, callback) {
    // Error.stack is slow, so expecting subscription calls are not many, use it carefully
    log.debug("Subscribing event", event, "from",
      new Error().stack.split("\n")[2]
        .replace("     at", "")
        .replace(/.*\//, "")
        .replace(/:[^:]*$/,""));
    super.on(event, callback);
  }

  clearAllSubscriptions() {
    super.removeAllListeners();
  }
}

function getInstance() {
  if(!instance) {
    instance = new SensorEventManager();
  }
  return instance;
}

module.exports = {
  getInstance:getInstance
}
