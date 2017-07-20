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

let instance = null;

class SensorEventManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }
  emitEvent(event) {
    log.info("New Event: " + event.type + " -- " + event.message);
    log.info(event.type, "subscribers: ", this.listenerCount(event.type), {});
    if(this.listenerCount(event.type) === 0) {
      log.error("No subscription on event type:", event.type, {});
    } else {
      this.emit(event.type, event);  
    }
  }
  
  on(event, callback) {
    // Error.stack is slow, so expecting subscription calls are not many, use it carefully
    log.info("Subscribing event", event, "from", 
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
