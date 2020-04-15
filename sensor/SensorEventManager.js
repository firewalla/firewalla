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

/* Event list at 2018.11.2 (via global search emitEvent)
 *
 * DDNS:Updated
 * DestIPFound
 * DeviceOffline
 * DeviceUpdate
 * IPTABLES_READY
 * IPv6DeviceInfoUpdate
 * NewDevice
 * NewDeviceFound
 * NewDeviceWithMacOnly
 * OldDeviceChangedToNewIP
 * OldDeviceTakenOverOtherDeviceIP
 * PolicyEnforcement
 * PublicIP:Updated
 * RefreshMacBackupName
 * RegularDeviceInfoUpdate
 * ReleaseMonkey
 * ReloadDNSRule
 * StartDHCP
 * StartDNS
 * StopDHCP
 * StopDNS
 * UPDATE_CATEGORY_DOMAIN
 * VPNConnectionAccepted
 * Alarm:NewAlarm
 * Policy:AllInitialized
 * Policy:CountryActivated
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
      if(channel === this.getRemoteChannel(process.title) || channel === "TO.*") {
        log.info(`Got a remote message for channel ${channel}: ${message}`)
        try {
          let m = JSON.parse(message)

          // only process redis events not originated from this process
          // local event will be processed by EventEmitter
          if(m.fromProcess !== process.title) {
            this.emitLocalEvent(m); // never send remote pubsub event back to remote 
          }
        } catch (err) {
          log.error("Failed to parse channel message:", err);
        }
      } else {
        log.debug("Ignore channel", channel);
      }
    });

    sclient.subscribe(this.getRemoteChannel(process.title));
    sclient.subscribe(this.getRemoteChannel("*")); // subscribe events for all components
  }

  clearEventType(eventType) {
    this.removeAllListeners(eventType)
  }
  
  sendEvent(event, target) {
    this.emitEvent(Object.assign({}, event, {
      toProcess: target
    }))
  }

  sendEventToFireApi(event) {
    this.sendEvent(event, "FireApi");
  }

  sendEventToFireMain(event) {
    this.sendEvent(event, "FireMain");
  }

  sendEventToFireMon(event) {
    this.sendEvent(event, "FireMon");
  }

  sendEventToAll(event) {
    this.sendEvent(event, "*");
  }
  
  emitLocalEvent(event) {
    if(!event.suppressEventLogging) {
      log.info("New Event: " + event.type + " -- " + (event.message || "(no message)"));
    }

    log.debug(event.type, "subscribers: ", this.listenerCount(event.type));
    let count = this.listenerCount(event.type);
    if(count === 0) {
      log.warn("No subscription on event type:", event.type);
    } else if (count > 1) {
      // most of time, only one subscribe on each event type
      log.debug("Subscribers on event type:", event.type, "is more than ONE");
      this.emit(event.type, event);
    } else {
      this.emit(event.type, event);
    }
  }

  emitEvent(event) {
    if(event.toProcess && event.toProcess !== process.title) {
      if(!event.suppressEventLogging) {
        log.info("New Event: " + event.type + " -- " + (event.message || "(no message)"));
      }

      // this event is meant to send to another process
      let channel = this.getRemoteChannel(event.toProcess);
      const eventCopy = JSON.parse(JSON.stringify(event));
      eventCopy.fromProcess = process.title;
      pclient.publish(channel, JSON.stringify(eventCopy));
      return; // local will also be processed in .on(channel, event)..
    }

    this.emitLocalEvent(event);
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

  once(event, callback) {
    // Error.stack is slow, so expecting subscription calls are not many, use it carefully
    log.debug("Subscribing event", event, "from",
    new Error().stack.split("\n")[2]
      .replace("     at", "")
      .replace(/.*\//, "")
      .replace(/:[^:]*$/,""));
   super.once(event, callback);
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
