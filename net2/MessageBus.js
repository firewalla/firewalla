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

let log = require('./logger.js')(__filename);

const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

/*
 * Channels
 *
 *   DiscoveryEvent
 *     -> Notice:Detected
 *     -> Scan:Done
 *     -> DiscoveryStart 
 *
 */

var instances = {};

module.exports = class {
    constructor(loglevel,instanceId, throttle) {
        let instance = null;
        if (instanceId == null) {
            instanceId = 'default'; 
        }        
        instance = instances[instanceId];
        if (instance == null) {
          instance = this;
          instances[instanceId]=instance;
          this.callbacks = {};
          this.throttle = 1;
          if (throttle) {
              this.throttle =throttle;
          }
          this.sending = false;
          sclient.on("message", (channel, message) => {
            try {
              let m = JSON.parse(message);
              log.debug("Reciving Msg:", m, {});
              let notified = 0;
              let cbs = null;
              if (m.ip && m.ip.length > 3 && this.callbacks[channel + '.' + m.type + "." + m.ip] != null) {
                cbs = this.callbacks[channel + "." + m.type + "." + m.ip];
                if(cbs) {
                  cbs.forEach((cb) => {
                    cb(channel, m.type, m.ip, m.msg);
                    notified += 1;
                  });
                }
              }
              if (this.callbacks[channel + "." + m.type]) {
                cbs = this.callbacks[channel + "." + m.type]
                if(cbs) {
                  cbs.forEach((cb) => {
                    cb(channel, m.type, m.ip, m.msg);
                    notified += 1;
                  });
                }
              }
              log.debug("Notified ", notified);
            } catch(err) {
              log.error("Error to process message:", message, "err:", err, {})
            }
            
          });
        }
      return instance;
    }

    publish(channel, type, ip, msg) {
        let o = {
            type: type,
            ip: ip,
            msg: msg
        };
      log.debug("MBus:Publish", channel, o, {});
      pclient.publish(channel, JSON.stringify(o));
    }

  publishCompressed(channel, type, ip, msg) {
    if (this.sending == true) {
      log.info("suppressing message:", channel, type, ip, msg, {})
      return;
    }
    
    this.sending = true;
       
        setTimeout(()=>{
            this.sending = false;
            this.publish(channel,type,ip,msg);
        }, this.throttle*1000);
    }

  _subscribe(key, callback) {
    let cbs = this.callbacks[key];
    if(!cbs) {
      this.callbacks[key] = [];
      cbs = this.callbacks[key];
    }
    cbs.push(callback);
  }
      
    subscribe(channel, type, ip, callback) {
        //log.debug("MBus:Subscribe",channel,type,ip);
      sclient.subscribe(channel);
      if (ip == null) {
        this._subscribe(channel + "." + type, callback);
      } else {
        this._subscribe(channel + "." + type + "." + ip, callback);
      }
    }
};
